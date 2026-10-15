export function tunnelCommand(env: Record<string, string | undefined>): {
  provider: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  temporary?: boolean;
};
