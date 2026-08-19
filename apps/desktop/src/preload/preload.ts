import { contextBridge, ipcRenderer } from 'electron';
import type {
  CortexLumeProject,
  DesktopApi,
  FitPlacementRequest,
  TargetImportSpace,
} from '@cortexlume/contracts';

const api: DesktopApi = {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    save: (project: CortexLumeProject, currentPath?: string) =>
      ipcRenderer.invoke('project:save', project, currentPath),
  },
  input: {
    digitizer: () => ipcRenderer.invoke('input:digitizer'),
    targetNifti: (declaredSpace: TargetImportSpace) =>
      ipcRenderer.invoke('input:target-nifti', declaredSpace),
  },
  export: {
    csv: (project: CortexLumeProject) => ipcRenderer.invoke('export:csv', project),
    brainNet: (project: CortexLumeProject) => ipcRenderer.invoke('export:brainnet', project),
    bidsGeometry: (project: CortexLumeProject) =>
      ipcRenderer.invoke('export:bids-geometry', project),
  },
  science: {
    health: () => ipcRenderer.invoke('science:health'),
    fitPlacement: (request: FitPlacementRequest) =>
      ipcRenderer.invoke('science:fit-placement', request),
    atlasLookup: (point, probabilityThreshold) =>
      ipcRenderer.invoke('science:atlas-lookup', point, probabilityThreshold),
    atlasLookupPath: (points, probabilityThreshold) =>
      ipcRenderer.invoke('science:atlas-lookup-path', points, probabilityThreshold),
    annotateProject: (project) => ipcRenderer.invoke('science:annotate-project', project),
    quickTargetSearch: (query, limit) =>
      ipcRenderer.invoke('science:quick-target-search', query, limit),
    quickTargetMap: (targetId) =>
      ipcRenderer.invoke('science:quick-target-map', targetId),
  },
};

contextBridge.exposeInMainWorld('cortexlume', api);
