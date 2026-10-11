export function ensureEnv(path?: string): boolean;
export function readEnvFile(path?: string): Record<string, string>;
export function needsBuild(srcDir?: string, built?: string): boolean;
