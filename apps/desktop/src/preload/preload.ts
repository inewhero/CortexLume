import { contextBridge, ipcRenderer } from 'electron';
import type {
  CortexLumeProject,
  DesktopApi,
  FitPlacementRequest,
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
  export: {
    csv: (project: CortexLumeProject) => ipcRenderer.invoke('export:csv', project),
    bidsGeometry: (project: CortexLumeProject) =>
      ipcRenderer.invoke('export:bids-geometry', project),
  },
  science: {
    health: () => ipcRenderer.invoke('science:health'),
    fitPlacement: (request: FitPlacementRequest) =>
      ipcRenderer.invoke('science:fit-placement', request),
  },
};

contextBridge.exposeInMainWorld('cortexlume', api);
