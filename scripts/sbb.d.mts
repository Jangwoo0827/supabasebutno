export class UsageError extends Error {}
export function parseColumn(spec: string): Record<string, unknown>;
export function buildColumns(specs: string[]): Record<string, unknown>[];
export const PRESETS: string[];
export function presetPolicy(preset: string, ownerColumn?: string): Record<string, unknown>;
export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> };
export interface SbbIo {
  env?: Record<string, string | undefined>;
  envFile?: Record<string, string>;
  fetch?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
  readFile?: (path: string) => string;
}
export function main(argv: string[], io?: SbbIo): Promise<number>;
