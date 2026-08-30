import type { CortexLumeProject, Vec3 } from '@cortexlume/contracts';

export type McpScreenshotPreset = 'gui-default' | 'front' | 'left' | 'right' | 'superior';

export interface McpScreenshotCameraState {
  source: 'preset' | 'explicit';
  preset: McpScreenshotPreset | null;
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov: number;
  near: number;
  far: number;
}

export interface McpScreenshotLayerState {
  scalp: boolean;
  grayMatter: boolean;
  whiteMatter: boolean;
  fivePoint: boolean;
  tenTen: boolean;
  /** Controls ordinary 10-10 position labels; five-point labels follow fivePoint. */
  pointLabels: boolean;
  fivePointLabelsIncluded: boolean;
  channelLabels: boolean;
  surfaceOverlay: 'none' | 'functional-target' | 'coverage-mosaic' | 'coverage-region';
  functionalMap: boolean;
  patches: boolean;
  digitizer: boolean;
  anatomicalCoverage: boolean;
  /** Ground grid is always excluded from scientific captures. */
  groundGrid: false;
}

export interface McpScreenshotRenderRequest {
  project: CortexLumeProject;
  projectPath: string;
  sourceProjectSha256: string;
  temporaryPath: string;
  logicalWidth: number;
  logicalHeight: number;
  dpr: number;
  camera: McpScreenshotCameraState;
  layers: McpScreenshotLayerState;
}

export interface McpScreenshotRenderResult {
  width: number;
  height: number;
  camera: McpScreenshotCameraState;
  layers: McpScreenshotLayerState;
}

export interface McpScreenshotWorkerRequest extends McpScreenshotRenderRequest {
  version: 1;
  resultPath: string;
}

export interface McpScreenshotWorkerCompletion extends McpScreenshotRenderResult {
  pngBase64: string;
}
