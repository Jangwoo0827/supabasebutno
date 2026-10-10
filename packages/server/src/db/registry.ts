import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { conflict, notFound } from '../core/errors.js';
import { PROJECT_ID_RE, newProjectId } from '../core/ids.js';
import type { Database } from './driver.js';
import { migrate } from './migrate.js';
import { controlMigrations, projectMigrations } from './migrations.js';
import { openSqlite } from './sqlite/driver.js';

export interface ProjectRecord {
  id: string;
  name: string;
  /** Bumped on key rotation; embedded in API keys as `kv`. */
  key_version: number;
  /** Unix seconds; used as the `iat` of the API keys so they stay deterministic. */
  keys_issued_at: number;
  created_at: string;
}

const COLUMNS = 'id, name, key_version, keys_issued_at, created_at';

/**
 * Owns the control-plane database (admin.sqlite) and one lazily-opened,
 * cached database handle per project:
 *
 *   <dataDir>/admin.sqlite
 *   <dataDir>/projects/<id>/db.sqlite        (user tables + reserved _tables)
 *   <dataDir>/projects/<id>/storage/         (Phase 4)
 */
export class ProjectRegistry {
  private readonly handles = new Map<string, Promise<Database>>();

  private constructor(
    readonly dataDir: string,
    private readonly control: Database,
  ) {}

  static async open(dataDir: string): Promise<ProjectRegistry> {
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    const control = openSqlite(join(dataDir, 'admin.sqlite'));
    await migrate(control, controlMigrations);
    return new ProjectRegistry(dataDir, control);
  }

  /** Absolute directory of a project. The id format check makes path traversal impossible. */
  projectDir(id: string): string {
    if (!PROJECT_ID_RE.test(id)) throw new Error('Invalid project id');
    const root = resolve(this.dataDir, 'projects');
    const dir = resolve(root, id);
    if (!dir.startsWith(root + sep)) throw new Error('Invalid project path');
    return dir;
  }

  list(): Promise<ProjectRecord[]> {
    return this.control.all<ProjectRecord>(`SELECT ${COLUMNS} FROM projects ORDER BY created_at, id`);
  }

  get(id: string): Promise<ProjectRecord | undefined> {
    if (!PROJECT_ID_RE.test(id)) return Promise.resolve(undefined);
    return this.control.get<ProjectRecord>(`SELECT ${COLUMNS} FROM projects WHERE id = ?`, [id]);
  }

  async create(name: string): Promise<ProjectRecord> {
    const record: ProjectRecord = {
      id: newProjectId(),
      name,
      key_version: 1,
      keys_issued_at: Math.floor(Date.now() / 1000),
      created_at: new Date().toISOString(),
    };
    try {
      await this.control.run(`INSERT INTO projects (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
        record.id,
        record.name,
        record.key_version,
        record.keys_issued_at,
        record.created_at,
      ]);
    } catch (err) {
      if (this.control.dialect.isUniqueViolation(err)) {
        throw conflict('project_exists', `A project named "${name}" already exists`);
      }
      throw err;
    }

    try {
      await mkdir(this.projectDir(record.id), { recursive: true });
      await this.db(record.id); // creates db.sqlite and runs project migrations
    } catch (err) {
      await this.delete(record.id).catch(() => undefined);
      throw err;
    }
    return record;
  }

  /** Revokes every API key of the project by bumping its key version. */
  async rotateKeys(id: string): Promise<ProjectRecord> {
    const res = await this.control.run('UPDATE projects SET key_version = key_version + 1, keys_issued_at = ? WHERE id = ?', [
      Math.floor(Date.now() / 1000),
      id,
    ]);
    const project = res.changes > 0 ? await this.get(id) : undefined;
    if (!project) throw notFound('Project');
    return project;
  }

  /** Removes the project row first (so no new request can resolve it), then its files. */
  async delete(id: string): Promise<void> {
    await this.control.run('DELETE FROM projects WHERE id = ?', [id]);
    const handle = this.handles.get(id);
    this.handles.delete(id);
    if (handle) await handle.then((db) => db.close()).catch(() => undefined);
    await rm(this.projectDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  /** The project's database. Handles are opened on first use and then kept open. */
  async db(id: string): Promise<Database> {
    let handle = this.handles.get(id);
    if (!handle) {
      if (!(await this.get(id))) throw notFound('Project');
      handle = this.openProject(id).catch((err) => {
        this.handles.delete(id);
        throw err;
      });
      this.handles.set(id, handle);
    }
    return handle;
  }

  private async openProject(id: string): Promise<Database> {
    const db = openSqlite(join(this.projectDir(id), 'db.sqlite'));
    try {
      await migrate(db, projectMigrations);
      // Guards against a database file restored into the wrong project directory.
      const meta = await db.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'project_id'`);
      if (!meta) {
        await db.run(`INSERT INTO _meta (key, value) VALUES ('project_id', ?)`, [id]);
      } else if (meta.value !== id) {
        throw new Error(`Database file belongs to project ${meta.value}, not ${id}`);
      }
      return db;
    } catch (err) {
      await db.close().catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(handles.map((h) => h.then((db) => db.close()).catch(() => undefined)));
    await this.control.close();
  }
}
