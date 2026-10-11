#!/usr/bin/env node
// sbb — manage a supabasebutno server from the command line (projects, tables, policies, buckets, keys).
//
//   npm run sbb -- new my-game
//   npm run sbb -- table my-game scores player:text:nn time_ms:integer:nn user_id:text
//   npm run sbb -- policy my-game scores leaderboard
//   npm run sbb -- snippet my-game
//
// Talks to the admin API with ADMIN_TOKEN. Address and token come from the repo's .env (written by `npm run local`),
// or from SBB_URL / SBB_ADMIN_TOKEN in the environment. Zero dependencies.
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnvFile } from './local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = ['text', 'integer', 'real', 'boolean', 'json', 'timestamp', 'uuid'];

export class UsageError extends Error {}

// ---- pure helpers (tested directly) --------------------------------------------------------------

/**
 * `name:type[:flag...]`, flags: pk, nn (not null), unique, default=<value|now|uuid|null>.
 *   id:integer:pk   player:text:nn   created_at:timestamp:default=now   done:boolean:nn:default=false
 */
export function parseColumn(spec) {
  const [name, type = 'text', ...flags] = spec.split(':');
  if (!name) throw new UsageError(`Bad column "${spec}": expected name:type[:flags]`);
  if (!TYPES.includes(type)) throw new UsageError(`Bad column "${spec}": type must be one of ${TYPES.join(', ')}`);
  const col = { name, type };
  for (const flag of flags) {
    if (flag === 'pk') col.primary_key = true;
    else if (flag === 'nn') col.not_null = true;
    else if (flag === 'unique') col.unique = true;
    else if (flag.startsWith('default=')) col.default = parseDefault(type, flag.slice('default='.length), spec);
    else throw new UsageError(`Bad column "${spec}": unknown flag "${flag}" (use pk, nn, unique, default=…)`);
  }
  return col;
}

function parseDefault(type, raw, spec) {
  if (raw === 'now' || raw === 'uuid') return { fn: raw };
  if (raw === 'null') return null;
  if (type === 'integer' || type === 'real') {
    if (raw === '' || Number.isNaN(Number(raw))) throw new UsageError(`Bad column "${spec}": default must be a number`);
    return Number(raw);
  }
  if (type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new UsageError(`Bad column "${spec}": default must be true or false`);
    return raw === 'true';
  }
  return raw;
}

/** Columns for a new table; adds `id integer primary key` when none was marked pk. */
export function buildColumns(specs) {
  const columns = specs.map(parseColumn);
  if (!columns.some((c) => c.primary_key)) columns.unshift({ name: 'id', type: 'integer', primary_key: true });
  return columns;
}

export const PRESETS = ['public-read', 'authenticated', 'owner', 'leaderboard'];

/** A policy from a preset name like `owner` or `leaderboard=user_id`. `ownerColumn` is used when the name does not give one. */
export function presetPolicy(preset, ownerColumn) {
  const [name, col] = preset.split('=');
  const owner = col || ownerColumn;
  const needOwner = () => {
    if (!owner) throw new UsageError(`Preset "${name}" needs a column that holds the user's id: name one (${name}=user_id) or add a user_id/owner column to the table`);
    return owner;
  };
  switch (name) {
    case 'public-read':
      return { select: { roles: ['anon', 'authenticated'], where: true } };
    case 'authenticated':
      return {
        select: { roles: ['authenticated'], where: true },
        insert: { roles: ['authenticated'] },
        update: { roles: ['authenticated'], where: true },
        delete: { roles: ['authenticated'], where: true },
      };
    case 'owner':
      return {
        select: { roles: ['authenticated'], where: { [needOwner()]: '$uid' } },
        insert: { roles: ['authenticated'], set: { [owner]: '$uid' } },
        update: { roles: ['authenticated'], where: { [owner]: '$uid' } },
        delete: { roles: ['authenticated'], where: { [owner]: '$uid' } },
      };
    case 'leaderboard':
      return {
        select: { roles: ['anon', 'authenticated'], where: true },
        insert: { roles: ['authenticated'], set: { [needOwner()]: '$uid' } },
        delete: { roles: ['authenticated'], where: { [owner]: '$uid' } },
      };
    default:
      throw new UsageError(`Unknown preset "${name}". Presets: ${PRESETS.join(', ')} — or give a path to a JSON file.`);
  }
}

/** Splits argv into positionals and --flags (`--public`, `--max-bytes 100`, `--types=a,b`). */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) positional.push(a);
    else {
      const [key, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['public', 'json', 'force', 'help'].includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    }
  }
  return { positional, flags };
}

const HELP = `sbb — manage supabasebutno

  sbb status                                   is the server up? how many projects?
  sbb list                                     projects
  sbb new <name>                               create a project, print its keys
  sbb keys <project>                           anon / service_role keys
  sbb snippet <project>                        copy-paste code to use the project in a web page
  sbb table <project> <table> <col>...         create a table. col = name:type[:pk][:nn][:unique][:default=…]
                                               (an "id" integer primary key is added if none is marked pk)
                                               types: ${TYPES.join(' ')}
  sbb tables <project>                         show tables
  sbb policy <project> <table> <preset|file>   presets: ${PRESETS.join(', ')}  (owner/leaderboard accept =column)
  sbb bucket <project> <name> [--public] [--max-bytes N] [--types image/*,audio/*]
  sbb delete <project> --confirm <name>        permanently delete a project

  --json     machine-readable output (keys, ids)
Environment: SBB_URL, SBB_ADMIN_TOKEN (default: the repo's .env).`;

// ---- the command-line program --------------------------------------------------------------------------

/**
 * Runs one command. `io` is injectable for tests: { env, fetch, out(line), readFile }.
 * Returns the process exit code.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const fetchFn = io.fetch ?? fetch;
  const read = io.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const { positional, flags } = parseArgs(argv);
  const [command, ...args] = positional;

  if (!command || command === 'help' || flags.help) {
    out(HELP);
    return command || flags.help ? 0 : 1;
  }

  const envFile = io.envFile ?? readEnvFile(join(root, '.env'));
  const env = { ...envFile, ...(io.env ?? process.env) };
  const host = env.HOST && env.HOST !== '0.0.0.0' ? env.HOST : '127.0.0.1';
  const base = (env.SBB_URL ?? `http://${host}:${env.PORT ?? '8787'}`).replace(/\/+$/, '');
  const token = env.SBB_ADMIN_TOKEN ?? env.ADMIN_TOKEN;

  async function api(method, path, body) {
    if (!token) throw new UsageError('No admin token: run `npm run local` once (it writes .env), or set SBB_ADMIN_TOKEN.');
    let res;
    try {
      res = await fetchFn(`${base}/admin${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new UsageError(`Cannot reach ${base}. Is the server running? Start it with: npm run local`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = json?.error;
      const details = Array.isArray(e?.details) ? `\n${e.details.map((d) => `  - ${d.path ? `${d.path}: ` : ''}${d.message}`).join('\n')}` : '';
      throw new Error(`${e?.code ?? `HTTP ${res.status}`}: ${e?.message ?? res.statusText}${details}`);
    }
    return json;
  }

  const project = async (ref) => {
    if (!ref) throw new UsageError('Give a project name or id.');
    const { projects } = await api('GET', '/projects');
    const found = projects.find((p) => p.id === ref) ?? projects.find((p) => p.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new UsageError(`No project "${ref}". Existing: ${projects.map((p) => p.name).join(', ') || '(none)'}`);
    return api('GET', `/projects/${found.id}`);
  };
  const need = (n, usage) => {
    if (args.length < n) throw new UsageError(`Usage: sbb ${usage}`);
  };
  const keysBlock = (p) => [`project:      ${p.name}  (${p.id})`, `url:          ${base}`, `anon key:     ${p.keys.anon}   (safe for web pages and games)`, `service key:  ${p.keys.service_role}   (SECRET: server-side only)`].join('\n');

  try {
    switch (command) {
      case 'status': {
        const health = await fetchFn(`${base}/health`).then((r) => r.json(), () => null);
        if (!health) {
          err(`Server not reachable at ${base}. Start it with: npm run local`);
          return 1;
        }
        const { projects } = await api('GET', '/projects');
        out(flags.json ? JSON.stringify({ url: base, status: health.status, projects: projects.length }) : `OK  ${base}  (${projects.length} project${projects.length === 1 ? '' : 's'})\nDashboard: ${base}/dashboard/`);
        return 0;
      }
      case 'list': {
        const { projects } = await api('GET', '/projects');
        out(flags.json ? JSON.stringify(projects) : projects.length ? projects.map((p) => `${p.id}  ${p.name}`).join('\n') : '(no projects)');
        return 0;
      }
      case 'new': {
        need(1, 'new <name>');
        const p = await api('POST', '/projects', { name: args.join(' ') });
        out(flags.json ? JSON.stringify({ id: p.id, name: p.name, url: base, anon: p.keys.anon, service_role: p.keys.service_role }) : `Created.\n${keysBlock(p)}`);
        return 0;
      }
      case 'keys': {
        need(1, 'keys <project>');
        const p = await project(args[0]);
        out(flags.json ? JSON.stringify({ id: p.id, name: p.name, url: base, anon: p.keys.anon, service_role: p.keys.service_role }) : keysBlock(p));
        return 0;
      }
      case 'snippet': {
        need(1, 'snippet <project>');
        const p = await project(args[0]);
        out(
          [
            `<script src="supabasebutno.min.js"></script>   <!-- copy packages/client/dist/index.global.min.js next to your page -->`,
            '<script>',
            `  const client = supabasebutno.createClient('${base}', '${p.keys.anon}');`,
            '  // client.from(\'table\').select().then(({ data, error }) => ...)',
            '</script>',
          ].join('\n'),
        );
        return 0;
      }
      case 'table': {
        need(3, 'table <project> <table> <name:type[:flags]>...');
        const p = await project(args[0]);
        const columns = buildColumns(args.slice(2));
        const t = await api('POST', `/projects/${p.id}/tables`, { name: args[1], columns });
        out(flags.json ? JSON.stringify(t) : `Created table ${t.name}: ${t.columns.map((c) => `${c.name}:${c.type}${c.primary_key ? ' (pk)' : ''}`).join(', ')}`);
        out(`Remember: until you add a policy only the service key can use it  →  sbb policy ${p.name} ${t.name} <preset>`);
        return 0;
      }
      case 'tables': {
        need(1, 'tables <project>');
        const p = await project(args[0]);
        const { tables } = await api('GET', `/projects/${p.id}/tables`);
        const { policies } = await api('GET', `/projects/${p.id}/policies`);
        const secured = new Set(policies.map((x) => x.table));
        out(flags.json ? JSON.stringify(tables) : tables.map((t) => `${t.name}  [${secured.has(t.name) ? 'policy' : 'NO POLICY (service key only)'}]  ${t.columns.map((c) => `${c.name}:${c.type}`).join(' ')}`).join('\n') || '(no tables)');
        return 0;
      }
      case 'policy': {
        need(3, `policy <project> <table> <${PRESETS.join('|')}|file.json>`);
        const p = await project(args[0]);
        let policy;
        if (args[2].endsWith('.json')) policy = JSON.parse(read(args[2]));
        else {
          const t = await api('GET', `/projects/${p.id}/tables/${args[1]}`);
          const guess = t.columns.find((c) => /^(user_id|owner|owner_id|author_id)$/.test(c.name) && ['text', 'uuid'].includes(c.type))?.name;
          policy = presetPolicy(args[2], guess);
        }
        await api('PUT', `/projects/${p.id}/policies/${args[1]}`, policy);
        out(flags.json ? JSON.stringify(policy) : `Policy applied to ${args[1]}:\n${JSON.stringify(policy, null, 2)}`);
        return 0;
      }
      case 'bucket': {
        need(2, 'bucket <project> <name> [--public] [--max-bytes N] [--types image/*,audio/*]');
        const p = await project(args[0]);
        const body = { name: args[1], public: flags.public === true };
        if (flags['max-bytes']) body.file_size_limit = Number(flags['max-bytes']);
        if (typeof flags.types === 'string') body.allowed_mime_types = flags.types.split(',').map((s) => s.trim()).filter(Boolean);
        const b = await api('POST', `/projects/${p.id}/storage/buckets`, body);
        out(flags.json ? JSON.stringify(b) : `Created ${b.public ? 'public' : 'private'} bucket ${b.name}`);
        return 0;
      }
      case 'delete': {
        need(1, 'delete <project> --confirm <name>');
        const p = await project(args[0]);
        if (flags.confirm !== p.name) throw new UsageError(`This permanently deletes "${p.name}" with all its data and files. Repeat with: --confirm "${p.name}"`);
        await api('DELETE', `/projects/${p.id}?confirm=${encodeURIComponent(p.name)}`);
        out(`Deleted ${p.name}`);
        return 0;
      }
      default:
        err(`Unknown command "${command}".\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    err(e instanceof UsageError ? e.message : `Error: ${e instanceof Error ? e.message : e}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
