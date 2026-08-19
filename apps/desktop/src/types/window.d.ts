import type { DesktopApi } from '@cortexlume/contracts';
import type { StartupRuntimeApi } from '../shared/startup';

declare global {
  interface Window {
    cortexlume: DesktopApi & { startup: StartupRuntimeApi };
  }
}

export {};
