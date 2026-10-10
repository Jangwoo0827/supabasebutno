import type { Database } from '../driver.js';
import { sqliteDialect } from './driver.js';
import type {
  AddColumnInput,
  ColumnInfo,
  ColumnInput,
  ColumnType,
  CreateTableInput,
  DefaultValue,
  SchemaDriver,
  TableInfo,
} from '../../schema/types.js';

const q = (name: string) => sqliteDialect.quoteIdent(name);

/**
 * Logical type -> declared SQLite type. SQLite keeps the declared type string
 * verbatim, so the logical type can be recovered on introspection without a
 * metadata table. The names are chosen so SQLite's affinity rules still apply:
 * anything containing "TEXT" gets TEXT affinity, BOOLEAN gets NUMERIC (0/1).
 */
const SQL_TYPE: Record<ColumnType, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'BOOLEAN',
  json: 'JSON_TEXT',
  timestamp: 'TIMESTAMP_TEXT',
  uuid: 'UUID_TEXT',
};
const LOGICAL_TYPE = new Map<string, ColumnType>(Object.entries(SQL_TYPE).map(([logical, sql]) => [sql, logical as ColumnType]));

// ISO-8601 UTC with milliseconds, e.g. 2026-01-02T03:04:05.678Z
const NOW_EXPR = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
// RFC 4122 version-4 UUID built from randomblob()
const UUID_EXPR =
  `lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'` +
  `||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))`;

/** DDL cannot use bound parameters, so literals are rendered here with strict escaping. */
function renderDefault(value: DefaultValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'object') return `(${value.fn === 'now' ? NOW_EXPR : UUID_EXPR})`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite default');
    return String(value);
  }
  if (value.includes('\0')) throw new Error('NUL in default');
  return `'${value.replaceAll("'", "''")}'`;
}

function columnDef(col: ColumnInput): string {
  const parts = [q(col.name), SQL_TYPE[col.type]];
  if (col.primary_key || col.not_null) parts.push('NOT NULL');
  if (col.primary_key) {
    parts.push('PRIMARY KEY');
    if (col.type === 'integer') parts.push('AUTOINCREMENT');
  }
  if (col.unique) parts.push('UNIQUE');
  if (col.default !== undefined) parts.push('DEFAULT', renderDefault(col.default));
  return parts.join(' ');
}

function inferType(declared: string): ColumnType {
  const known = LOGICAL_TYPE.get(declared.toUpperCase());
  if (known) return known;
  // Table edited outside the API: fall back to SQLite's own affinity rules.
  const t = declared.toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real';
  return 'text';
}

function parseDefault(type: ColumnType, raw: string | null): ColumnInfo['default'] {
  if (raw === null) return undefined;
  const s = raw.trim();
  if (/^null$/i.test(s)) return null;
  if (s === NOW_EXPR) return { fn: 'now' };
  if (s === UUID_EXPR) return { fn: 'uuid' };
  const str = /^'((?:[^']|'')*)'$/.exec(s);
  if (str) return str[1]!.replaceAll("''", "'");
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    return type === 'boolean' ? n !== 0 : n;
  }
  return { sql: s };
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export const sqliteSchemaDriver: SchemaDriver = {
  async listTableNames(db: Database) {
    const rows = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          AND name NOT LIKE '\\_%' ESCAPE '\\'
        ORDER BY name`,
    );
    return rows.map((r) => r.name);
  },

  async describeTable(db: Database, name: string): Promise<TableInfo | undefined> {
    // pragma_*() table-valued functions accept bound parameters, unlike PRAGMA statements.
    const cols = await db.all<TableInfoRow>(
      `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`,
      [name],
    );
    if (cols.length === 0) return undefined;

    const uniqueCols = new Set<string>();
    const indexes = await db.all<{ name: string }>(
      `SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND origin = 'u'`,
      [name],
    );
    for (const idx of indexes) {
      const idxCols = await db.all<{ name: string }>(`SELECT name FROM pragma_index_info(?)`, [idx.name]);
      if (idxCols.length === 1) uniqueCols.add(idxCols[0]!.name);
    }

    return {
      name,
      columns: cols.map((c): ColumnInfo => {
        const type = inferType(c.type);
        const def = parseDefault(type, c.dflt_value);
        return {
          name: c.name,
          type,
          primary_key: c.pk > 0,
          not_null: c.notnull === 1 || c.pk > 0,
          unique: uniqueCols.has(c.name),
          ...(def !== undefined ? { default: def } : {}),
        };
      }),
    };
  },

  createTableSql(input: CreateTableInput) {
    return `CREATE TABLE ${q(input.name)} (\n  ${input.columns.map(columnDef).join(',\n  ')}\n)`;
  },
  addColumnSql(table: string, column: AddColumnInput) {
    return `ALTER TABLE ${q(table)} ADD COLUMN ${columnDef(column)}`;
  },
  renameColumnSql: (table, from, to) => `ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)}`,
  dropColumnSql: (table, column) => `ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}`,
  renameTableSql: (from, to) => `ALTER TABLE ${q(from)} RENAME TO ${q(to)}`,
  dropTableSql: (name) => `DROP TABLE ${q(name)}`,
};
