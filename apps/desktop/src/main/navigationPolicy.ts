/**
 * Return whether a renderer navigation stays on the development app origin.
 *
 * The production window loads a packaged file and therefore has no permitted
 * navigation target.  In development, Vite may navigate to a nested route,
 * but the target must remain on the exact configured origin and under the
 * configured base pathname.  URL parsing is intentional here: string prefix
 * checks can both reject valid nested routes and accept a look-alike origin.
 */
export function isAllowedDevNavigation(url: string, devServerUrl?: string): boolean {
  if (!devServerUrl) return false;
  try {
    const destination = new URL(url);
    const base = new URL(devServerUrl);
    if (destination.origin !== base.origin) return false;
    if (destination.username || destination.password) return false;
    if (base.username || base.password) return false;

    const configuredPath = base.pathname || '/';
    const basePath = configuredPath === '/' ? '/' : configuredPath.replace(/\/+$/, '');
    if (destination.pathname === basePath) return true;
    const nestedBase = basePath === '/' ? '/' : `${basePath}/`;
    return destination.pathname.startsWith(nestedBase);
  } catch {
    return false;
  }
}
