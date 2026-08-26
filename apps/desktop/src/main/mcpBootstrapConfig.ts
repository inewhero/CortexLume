import path from 'node:path';

export const MCP_ROOT_CONFIGURATION_ERROR =
  'CortexLume MCP requires at least one authorized project root. Configure --mcp-root=<path> or CORTEXLUME_MCP_ROOTS.';

export function configuredRoots(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const argumentRoots = argv.flatMap((argument) => (
    argument.startsWith('--mcp-root=') ? [argument.slice('--mcp-root='.length).trim()] : []
  )).filter(Boolean);
  const environmentRoots = (environment.CORTEXLUME_MCP_ROOTS ?? '')
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  return [...argumentRoots, ...environmentRoots].map((root) => path.resolve(root));
}

export function requireConfiguredRoots(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = configuredRoots(argv, environment);
  if (roots.length === 0) throw new Error(MCP_ROOT_CONFIGURATION_ERROR);
  return roots;
}
