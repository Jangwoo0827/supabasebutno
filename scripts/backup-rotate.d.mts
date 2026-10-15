export function selectBackupsToDelete(names: string[], keep: number): string[];
export function uncompressedBackups(entries: { name: string; isDirectory(): boolean }[]): string[];
export function parseArgs(argv: string[], env?: Record<string, string | undefined>): { dir: string; keep: number; docker: boolean };
export function backupAndRotate(
  opts: { dir: string; keep: number; docker: boolean },
  runner?: (cmd: string, args: string[], opts?: { cwd?: string }) => void,
): { backupDir: string; packed: string[]; removed: string[]; kept: number };
