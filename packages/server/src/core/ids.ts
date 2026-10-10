import { randomInt } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Project ids double as directory names, so the format is strict: 16 chars of [a-z0-9]. */
export const PROJECT_ID_RE = /^[a-z0-9]{16}$/;

export function newProjectId(): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}
