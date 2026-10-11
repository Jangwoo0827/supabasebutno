import { badRequest } from '../core/errors.js';

// ---- object paths ---------------------------------------------------------

const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
const MAX_DEPTH = 20;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Validates a user-chosen object path such as `avatars/me/photo.png`. The path is only a
 * label stored in the database (bytes are stored under a random id), but it ends up in
 * URLs and download names, so it is kept boring: no `.`/`..`/empty segments, no control
 * characters or backslashes, bounded length.
 */
export function validateObjectPath(path: string): string {
  const segments = path.split('/');
  const bad =
    path.length === 0 ||
    Buffer.byteLength(path) > MAX_PATH_BYTES ||
    segments.length > MAX_DEPTH ||
    segments.some((s) => s === '' || s === '.' || s === '..' || Buffer.byteLength(s) > MAX_SEGMENT_BYTES || FORBIDDEN_CHARS.test(s));
  if (bad) throw badRequest('invalid_path', 'Invalid object path: use / separated names without empty, "." or ".." parts');
  return path;
}

/**
 * The path part of an absolute URL exactly as written. `new URL(...).pathname` is avoided on
 * purpose: the URL parser silently resolves `.` / `..` segments (and `%2e%2e`) and turns `\`
 * into `/`, which would hide exactly the input this module wants to reject.
 */
function rawPathname(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url)?.[1] || '/';
}

/**
 * Extracts the object path from the raw request path, e.g. `/storage/object/avatars/a/b.png`
 * with `skip` = 3 leading segments (`storage`, `object`, `avatars`) -> `a/b.png`.
 * Segments are split BEFORE percent-decoding, so an encoded slash (%2F) stays inside one
 * segment and is then rejected instead of silently creating a new directory level.
 */
export function objectPathFromUrl(url: string, skip: number): string {
  const segments = rawPathname(url).split('/').slice(1);
  const rest = segments.slice(skip);
  let decoded: string[];
  try {
    decoded = rest.map(decodeURIComponent);
  } catch {
    throw badRequest('invalid_path', 'Invalid percent-encoding in object path');
  }
  if (decoded.some((s) => s.includes('/'))) throw badRequest('invalid_path', 'Invalid object path');
  return validateObjectPath(decoded.join('/'));
}

// ---- content types --------------------------------------------------------

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** `Image/PNG; charset=x` -> `image/png`. Missing -> application/octet-stream. Garbage -> 400. */
export function normalizeMime(header: string | undefined): string {
  const base = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (base === '') return 'application/octet-stream';
  if (!MIME_RE.test(base) || base.length > 127) throw badRequest('invalid_content_type', 'Invalid Content-Type header');
  return base;
}

export const MIME_PATTERN_RE = /^([a-z0-9][a-z0-9!#$&^_.+-]*)\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;

/** `image/*` matches every image type; otherwise exact match. */
export function mimeAllowed(mime: string, patterns: readonly string[] | null): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => (p.endsWith('/*') ? mime.startsWith(p.slice(0, -1)) : p === mime));
}

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
};
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/**
 * For the few types with a well-known header, checks that the data really starts like that
 * type. This stops e.g. an HTML file being uploaded as `image/png`. Other types are trusted:
 * the declared type is client-supplied and only restricts what the bucket accepts.
 */
export function contentMatchesMime(mime: string, head: Uint8Array): boolean {
  const check = SIGNATURES[mime];
  return check ? check(head) : true;
}

// ---- serving --------------------------------------------------------------

/** Types a browser may render inline. Everything else (HTML, SVG, XML, scripts...) is forced to download. */
const INLINE_SAFE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac',
  'video/mp4', 'video/webm', 'video/ogg',
  'application/pdf', 'text/plain',
]);
export const isInlineSafe = (mime: string) => INLINE_SAFE.has(mime);

/** `attachment; filename="photo.png"; filename*=UTF-8''photo.png` with an ASCII-safe fallback. */
export function contentDisposition(kind: 'inline' | 'attachment', path: string): string {
  const name = path.split('/').pop() ?? 'file';
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Parses a single `bytes=a-b` range. Returns null for "serve everything" and 'invalid' for 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // unsupported syntax (e.g. several ranges): ignore and send the whole file
  const [, a, b] = m as unknown as [string, string, string];
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (size === 0 || start >= size || start > end) return 'invalid';
  return { start, end };
}
