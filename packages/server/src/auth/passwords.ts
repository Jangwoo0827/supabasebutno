import argon2 from 'argon2';

// OWASP-recommended argon2id parameters (19 MiB, 2 passes, 1 lane).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, OPTIONS);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same CPU time as a real verification. Used when the account does not
 * exist so that response time does not reveal which e-mail addresses are registered.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(await dummyHash, password);
}
