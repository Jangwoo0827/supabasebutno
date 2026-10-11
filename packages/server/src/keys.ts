import { hkdfSync } from 'node:crypto';
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { PROJECT_ID_RE } from './core/ids.js';
import type { ProjectRecord } from './db/registry.js';

export const API_KEY_ROLES = ['anon', 'service_role'] as const;
export type ApiKeyRole = (typeof API_KEY_ROLES)[number];

export interface ApiKeys {
  anon: string;
  service_role: string;
}

const ISSUER = 'supabasebutno';

/**
 * Per-project signing secret = HKDF-SHA256(master secret, salt = project id,
 * info = purpose + key version). Nothing secret is stored in the database, and
 * a key signed for project A can never validate for project B.
 *
 * `purpose` keeps API keys and user session tokens in separate key domains, so a
 * token of one kind can never validate as the other.
 */
export function deriveSecret(
  masterSecret: string,
  projectId: string,
  purpose: 'apikey' | 'user',
  version: number,
): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', masterSecret, projectId, `supabasebutno:${purpose}:v${version}`, 32));
}

type KeyedProject = Pick<ProjectRecord, 'id' | 'key_version' | 'keys_issued_at'>;

/**
 * Keys are deterministic for a given (master secret, project, key_version,
 * keys_issued_at), so they can be shown again at any time. They never expire;
 * rotate the project's keys to revoke them.
 */
export async function issueApiKeys(masterSecret: string, project: KeyedProject): Promise<ApiKeys> {
  const secret = deriveSecret(masterSecret, project.id, 'apikey', project.key_version);
  const sign = (role: ApiKeyRole) =>
    new SignJWT({ role, ref: project.id, kv: project.key_version })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setIssuedAt(project.keys_issued_at)
      .sign(secret);
  return { anon: await sign('anon'), service_role: await sign('service_role') };
}

/**
 * Verifies an API key. Returns null for ANY failure (malformed, wrong
 * signature, unknown project, rotated key, bad role) so callers can't leak
 * which check failed.
 */
export async function verifyApiKey(
  masterSecret: string,
  token: string,
  getProject: (id: string) => Promise<ProjectRecord | undefined>,
): Promise<{ project: ProjectRecord; role: ApiKeyRole } | null> {
  try {
    // The project id is read from the still-unverified token only to find which secret to verify with.
    const ref = decodeJwt(token).ref;
    if (typeof ref !== 'string' || !PROJECT_ID_RE.test(ref)) return null;
    const project = await getProject(ref);
    if (!project) return null;

    const secret = deriveSecret(masterSecret, project.id, 'apikey', project.key_version);
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer: ISSUER });

    if (payload.ref !== project.id || payload.kv !== project.key_version) return null;
    const role = payload.role;
    if (role !== 'anon' && role !== 'service_role') return null;
    return { project, role };
  } catch {
    return null;
  }
}
