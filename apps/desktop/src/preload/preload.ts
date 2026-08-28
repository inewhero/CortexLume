import { contextBridge, ipcRenderer } from 'electron';
import type {
  CortexLumeProject,
  DesktopApi,
  AnatomicalCoverageRequest,
  FitPlacementRequest,
  ProjectOperationProgress,
  TargetImportSpace,
} from '@cortexlume/contracts';
import type { StartupRuntimeApi } from '../shared/startup';

type CortexLumeDesktopApi = DesktopApi & { startup: StartupRuntimeApi };

const api: CortexLumeDesktopApi = {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onCloseRequested: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('window:close-requested', listener);
      return () => ipcRenderer.removeListener('window:close-requested', listener);
    },
    finishClose: (allow) => ipcRenderer.invoke('window:finish-close', allow),
  },
  startup: {
    checkUpdate: () => ipcRenderer.invoke('startup:check-update'),
    openRelease: () => ipcRenderer.invoke('startup:open-release'),
  },
  project: {
    startup: () => ipcRenderer.invoke('project:startup'),
    open: () => ipcRenderer.invoke('project:open'),
    save: (project: CortexLumeProject, currentPath?: string) =>
      ipcRenderer.invoke('project:save', project, currentPath),
    confirmUnsavedChanges: () => ipcRenderer.invoke('project:confirm-unsaved'),
  },
  input: {
    digitizer: () => ipcRenderer.invoke('input:digitizer'),
    targetNifti: (declaredSpace: TargetImportSpace) =>
      ipcRenderer.invoke('input:target-nifti', declaredSpace),
  },
  operations: {
    cancel: (operationId) => ipcRenderer.invoke('operations:cancel', operationId),
    onProgress: (callback: (progress: ProjectOperationProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: ProjectOperationProgress) => callback(progress);
      ipcRenderer.on('operations:progress', listener);
      return () => ipcRenderer.removeListener('operations:progress', listener);
    },
  },
  export: {
    csv: (project: CortexLumeProject, options) => ipcRenderer.invoke('export:csv', project, options),
    brainNet: (project: CortexLumeProject, options) => ipcRenderer.invoke('export:brainnet', project, options),
    bidsGeometry: (project: CortexLumeProject, options) =>
      ipcRenderer.invoke('export:bids-geometry', project, options),
  },
  science: {
    health: () => ipcRenderer.invoke('science:health'),
    fitPlacement: (request: FitPlacementRequest) =>
      ipcRenderer.invoke('science:fit-placement', request),
    atlasLookup: (point, probabilityThreshold) =>
      ipcRenderer.invoke('science:atlas-lookup', point, probabilityThreshold),
    atlasLookupPath: (points, probabilityThreshold) =>
      ipcRenderer.invoke('science:atlas-lookup-path', points, probabilityThreshold),
    annotateProject: (project, options) => ipcRenderer.invoke('science:annotate-project', project, options),
    quickTargetSearch: (query, limit) =>
      ipcRenderer.invoke('science:quick-target-search', query, limit),
    quickTargetMap: (targetId) =>
      ipcRenderer.invoke('science:quick-target-map', targetId),
    anatomicalCoverage: (request: AnatomicalCoverageRequest) =>
      ipcRenderer.invoke('science:anatomical-coverage', request),
  },
};

contextBridge.exposeInMainWorld('cortexlume', api);
