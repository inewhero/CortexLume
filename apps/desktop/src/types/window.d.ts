import type { DesktopApi } from '@cortexlume/contracts';

declare global {
  interface Window {
    cortexlume: DesktopApi;
  }
}

export {};
