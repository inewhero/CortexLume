import type { DesktopApi } from '@cortexlume/contracts';
import type { StartupRuntimeApi } from '../shared/startup';
import type {
  McpScreenshotWorkerCompletion,
  McpScreenshotWorkerRequest,
} from '../shared/mcpScreenshot';

declare global {
  interface Window {
    cortexlume: DesktopApi & { startup: StartupRuntimeApi };
    cortexlumeMcpScreenshot?: {
      request(): Promise<Pick<McpScreenshotWorkerRequest,
        'logicalWidth' | 'logicalHeight' | 'dpr' | 'camera' | 'layers'>>;
      complete(completion: McpScreenshotWorkerCompletion): Promise<{ accepted: true }>;
      fail(message: string): Promise<{ accepted: true }>;
    };
  }
}

export {};
