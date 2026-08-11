import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CortexLumeProjectSchema,
  FitPlacementRequestSchema,
  FitPlacementResponseSchema,
  AtlasLabelSchema,
  type CortexLumeProject,
  type FitPlacementRequest,
  type Vec3,
} from '@cortexlume/contracts';
import { createProjectArchive, readProjectArchive } from './projectArchive';
import { buildBidsGeometryExport, buildBrainNetExport, buildCsvExport, type ExportBundle } from './projectExport';

let mainWindow: BrowserWindow | null = null;
let scienceProcess: ChildProcessWithoutNullStreams | null = null;
let sciencePort: number | null = null;
let scienceToken = '';
let scienceReady: Promise<void> | null = null;
const headlessSmokeTest = process.env.CORTEXLUME_HEADLESS_TEST === '1';

function quadraticPathThroughTarget(source: Vec3, target: Vec3, detector: Vec3, count = 33): Vec3[] {
  const control: Vec3 = [
    2 * target[0] - (source[0] + detector[0]) / 2,
    2 * target[1] - (source[1] + detector[1]) / 2,
    2 * target[2] - (source[2] + detector[2]) / 2,
  ];
  return Array.from({ length: count }, (_, index): Vec3 => {
    const t = index / (count - 1);
    const a = (1 - t) ** 2;
    const b = 2 * (1 - t) * t;
    const c = t ** 2;
    return [
      a * source[0] + b * control[0] + c * detector[0],
      a * source[1] + b * control[1] + c * detector[1],
      a * source[2] + b * control[2] + c * detector[2],
    ];
  });
}

function resolveScienceCommand(): { command: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    const executable = path.join(process.resourcesPath, 'cortexlume-science', 'cortexlume-science.exe');
    return { command: executable, args: [], cwd: path.dirname(executable) };
  }

  const script = path.resolve(app.getAppPath(), '..', '..', 'services', 'science', 'run.py');
  const configuredPython = process.env.CORTEXLUME_PYTHON;
  if (configuredPython) {
    return { command: configuredPython, args: [script], cwd: path.dirname(script) };
  }
  return { command: 'py', args: ['-3.12', script], cwd: path.dirname(script) };
}

function startScienceSidecar(): Promise<void> {
  if (scienceReady) return scienceReady;
  scienceToken = randomBytes(32).toString('hex');
  const { command, args, cwd } = resolveScienceCommand();

  scienceReady = new Promise((resolve, reject) => {
    scienceProcess = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        CORTEXLUME_TOKEN: scienceToken,
        CORTEXLUME_ASSET_DIR: app.isPackaged
          ? path.join(process.resourcesPath, 'assets', 'templates', 'MNI152NLin6Asym')
          : path.resolve(app.getAppPath(), '..', '..', 'assets', 'templates', 'MNI152NLin6Asym'),
      },
    });

    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('Science sidecar startup timed out')), 20_000);

    scienceProcess.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('CORTEXLUME_READY ')) continue;
        const ready = JSON.parse(line.slice('CORTEXLUME_READY '.length)) as { port: number };
        sciencePort = ready.port;
        clearTimeout(timeout);
        resolve();
      }
    });
    scienceProcess.stderr.on('data', (chunk: Buffer) => console.error(`[science] ${chunk}`));
    scienceProcess.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    scienceProcess.once('exit', () => {
      sciencePort = null;
      scienceProcess = null;
      scienceReady = null;
    });
  });
  return scienceReady;
}

async function scienceRequest<T>(pathname: string, payload?: unknown): Promise<T> {
  await startScienceSidecar();
  if (!sciencePort) throw new Error('Science sidecar did not provide a port');
  const requestInit: RequestInit = {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${scienceToken}`,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  };
  if (payload !== undefined) requestInit.body = JSON.stringify(payload);
  const response = await fetch(`http://127.0.0.1:${sciencePort}${pathname}`, requestInit);
  if (!response.ok) {
    throw new Error(`Science service ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0a0d12',
    ...(app.isPackaged ? {} : { icon: path.join(app.getAppPath(), 'assets', 'icon.png') }),
    frame: false,
    show: !app.isPackaged && !headlessSmokeTest,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevNavigation = MAIN_WINDOW_VITE_DEV_SERVER_URL?.startsWith(url);
    if (!isDevNavigation) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (!headlessSmokeTest) mainWindow?.show();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  if (!headlessSmokeTest && !mainWindow.isVisible()) mainWindow.show();
}

async function atomicWrite(destination: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function chooseExportDirectory(title: string): Promise<string | null> {
  const choice = await dialog.showOpenDialog(mainWindow!, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  return choice.canceled ? null : (choice.filePaths[0] ?? null);
}

function projectFilename(name: string): string {
  const safeName = name.trim()
    .replaceAll(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replaceAll(/[. ]+$/g, '')
    || 'Untitled CortexLume project';
  return `${safeName}.cortexlume`;
}

function ensureProjectExtension(destination: string): string {
  return destination.toLowerCase().endsWith('.cortexlume')
    ? destination
    : `${destination}.cortexlume`;
}

async function writeExportBundle(directory: string, bundle: ExportBundle): Promise<string[]> {
  const files = Object.entries(bundle.files);
  const exportRoot = path.resolve(directory);
  await Promise.all(files.map(async ([filename, content]) => {
    const destination = path.resolve(exportRoot, filename);
    if (destination !== exportRoot && !destination.startsWith(`${exportRoot}${path.sep}`)) {
      throw new Error(`Invalid export path: ${filename}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await atomicWrite(destination, content);
  }));
  return files.map(([filename]) => filename);
}

interface BrainNetLaunchStatus {
  matlabFound: boolean;
  brainNetFound: boolean;
  launched: boolean;
  detail: string;
}

function matlabCommand(): string {
  return process.env.CORTEXLUME_MATLAB?.trim() || 'matlab';
}

function inspectBrainNet(command: string): Promise<BrainNetLaunchStatus> {
  const expression = [
    "location=which('BrainNet_MapCfg');",
    "if isempty(location), error('CORTEXLUME_BRAINNET_NOT_FOUND'); end;",
    "surface=fullfile(fileparts(location),'Data','SurfTemplate','BrainMesh_ICBM152.nv');",
    "if ~isfile(surface), error('CORTEXLUME_BRAINNET_SURFACE_NOT_FOUND'); end;",
    "fprintf('CORTEXLUME_BRAINNET_READY %s\\n',location);",
  ].join(' ');
  return new Promise((resolve) => {
    execFile(command, ['-batch', expression], { timeout: 90_000, windowsHide: true }, (error, stdout, stderr) => {
      const match = stdout.match(/CORTEXLUME_BRAINNET_READY\s+([^\r\n]+)/);
      if (!error && match) {
        resolve({ matlabFound: true, brainNetFound: true, launched: false, detail: match[1]!.trim() });
        return;
      }
      const missingExecutable = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      resolve({
        matlabFound: !missingExecutable,
        brainNetFound: false,
        launched: false,
        detail: (missingExecutable
          ? 'MATLAB executable was not found. Set CORTEXLUME_MATLAB to matlab.exe.'
          : `${stderr || stdout || error?.message || 'BrainNet Viewer was not found on the MATLAB path.'}`.trim()).slice(-500),
      });
    });
  });
}

function launchBrainNet(command: string, scriptPath: string, status: BrainNetLaunchStatus): BrainNetLaunchStatus {
  const escapedPath = scriptPath.replaceAll("'", "''");
  const expression = `try, run('${escapedPath}'); catch error, disp(getReport(error,'extended')); end`;
  const child = spawn(command, ['-r', expression], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { ...status, launched: true, detail: `BrainNet Viewer launched via ${status.detail}` };
}

function registerIpc(): void {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  ipcMain.handle('project:open', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open CortexLume project',
      properties: ['openFile'],
      filters: [{ name: 'CortexLume project', extensions: ['cortexlume'] }],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    const project = readProjectArchive(new Uint8Array(await readFile(selectedPath)));
    return { project, path: selectedPath };
  });

  ipcMain.handle(
    'project:save',
    async (_event, rawProject: CortexLumeProject, currentPath?: string) => {
      const project = CortexLumeProjectSchema.parse(rawProject);
      let destination = currentPath;
      if (!destination) {
        const selection = await dialog.showSaveDialog(mainWindow!, {
          title: 'Save CortexLume project',
          defaultPath: projectFilename(project.name),
          filters: [{ name: 'CortexLume project', extensions: ['cortexlume'] }],
        });
        if (selection.canceled || !selection.filePath) return null;
        destination = ensureProjectExtension(selection.filePath);
      }
      await atomicWrite(destination, createProjectArchive(project, app.getVersion()));
      return { path: destination };
    },
  );

  ipcMain.handle('export:csv', async (_event, rawProject: CortexLumeProject) => {
    const project = CortexLumeProjectSchema.parse(rawProject);
    const directory = await chooseExportDirectory('Export CortexLume CSV files');
    if (!directory) return null;
    await mkdir(directory, { recursive: true });
    const bundle = buildCsvExport(project);
    const files = await writeExportBundle(directory, bundle);
    return { directory, files, warnings: bundle.warnings };
  });

  ipcMain.handle('export:brainnet', async (_event, rawProject: CortexLumeProject) => {
    const project = CortexLumeProjectSchema.parse(rawProject);
    const directory = await chooseExportDirectory('Export and open in BrainNet Viewer');
    if (!directory) return null;
    await mkdir(directory, { recursive: true });
    const bundle = buildBrainNetExport(project);
    const files = await writeExportBundle(directory, bundle);
    const command = matlabCommand();
    let brainNet = await inspectBrainNet(command);
    const hasCorticalCoordinates = project.verifiedResults.some(
      (result) => result.subjectKind === 'optode' && result.corticalRasMm?.every(Number.isFinite),
    );
    if (brainNet.brainNetFound && hasCorticalCoordinates) {
      brainNet = launchBrainNet(command, path.join(directory, 'cortexlume_open_brainnet.m'), brainNet);
    } else if (!hasCorticalCoordinates) {
      brainNet = { ...brainNet, detail: 'Exported files, but no finite cortical optode coordinates were available to load.' };
    }
    const warnings = [
      ...bundle.warnings,
      ...(brainNet.launched ? [] : [brainNet.detail]),
    ];
    return { directory, files, warnings, brainNet };
  });

  ipcMain.handle('export:bids-geometry', async (_event, rawProject: CortexLumeProject) => {
    const project = CortexLumeProjectSchema.parse(rawProject);
    const directory = await chooseExportDirectory('Export BIDS-compatible geometry sidecars');
    if (!directory) return null;
    await mkdir(directory, { recursive: true });
    const bundle = buildBidsGeometryExport(project);
    const files = await writeExportBundle(directory, bundle);
    return { directory, files, warnings: bundle.warnings };
  });

  ipcMain.handle('science:health', async () => {
    try {
      return await scienceRequest<{ ok: boolean; version: string; templateVerified: boolean }>('/v1/health');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('science:fit-placement', async (_event, rawRequest: FitPlacementRequest) => {
    const request = FitPlacementRequestSchema.parse(rawRequest);
    const response = await scienceRequest<unknown>('/v1/placements/fit', request);
    return FitPlacementResponseSchema.parse(response);
  });

  ipcMain.handle('science:atlas-lookup', async (_event, point: [number, number, number], probabilityThreshold = 0) => {
    const response = await scienceRequest<{
      atlasVerified: boolean;
      results: Array<{ corticalRegions: unknown[] }>;
    }>('/v1/atlas/query-batch', {
      points: [{ id: 'selection', corticalRasMm: point, deepTargetRasMm: null }],
      probabilityThreshold,
    });
    const candidate = response.results[0]?.corticalRegions ?? [];
    return AtlasLabelSchema.array().parse(candidate);
  });

  ipcMain.handle('science:atlas-lookup-path', async (
    _event,
    points: Array<[number, number, number]>,
    probabilityThreshold = 0,
  ) => {
    const response = await scienceRequest<{
      atlasVerified: boolean;
      regions: unknown[];
    }>('/v1/atlas/query-path', { points, probabilityThreshold });
    return AtlasLabelSchema.array().parse(response.regions ?? []);
  });

  ipcMain.handle('science:annotate-project', async (_event, rawProject: CortexLumeProject) => {
    const project = CortexLumeProjectSchema.parse(rawProject);
    const response = await scienceRequest<{
      atlasVerified: boolean;
      issue: string | null;
      results: Array<{
        id: string;
        corticalRegions: CortexLumeProject['verifiedResults'][number]['underlyingCorticalRegions'];
        deepStructures: CortexLumeProject['verifiedResults'][number]['deepTargetStructures'];
      }>;
    }>('/v1/atlas/query-batch', {
      points: project.verifiedResults.map((result, index) => ({
        id: String(index),
        corticalRasMm: result.corticalRasMm,
        deepTargetRasMm: result.depthTargetRasMm,
      })),
      probabilityThreshold: project.projectionSettings.atlasProbabilityThreshold,
    });
    const byIndex = new Map(response.results.map((result) => [Number(result.id), result]));
    const pathRegions = await Promise.all(project.verifiedResults.map(async (result) => {
      if (result.subjectKind !== 'pair' || !result.instanceId || !result.corticalRasMm) return null;
      const instance = project.instances.find((candidate) => candidate.id === result.instanceId);
      const layout = project.layouts.find((candidate) => candidate.id === instance?.definitionId);
      const pair = layout?.pairs.find((candidate) => candidate.id === result.subjectId);
      if (!pair) return null;
      const source = project.verifiedResults.find((candidate) =>
        candidate.instanceId === result.instanceId
        && candidate.subjectKind === 'optode'
        && candidate.subjectId === pair.sourceId)?.corticalRasMm;
      const detector = project.verifiedResults.find((candidate) =>
        candidate.instanceId === result.instanceId
        && candidate.subjectKind === 'optode'
        && candidate.subjectId === pair.detectorId)?.corticalRasMm;
      if (!source || !detector) return null;
      const pathResponse = await scienceRequest<{ regions: unknown[] }>('/v1/atlas/query-path', {
        points: quadraticPathThroughTarget(source, result.corticalRasMm, detector),
        probabilityThreshold: project.projectionSettings.atlasProbabilityThreshold,
      });
      return AtlasLabelSchema.array().parse(pathResponse.regions ?? []);
    }));
    return CortexLumeProjectSchema.parse({
      ...project,
      verifiedResults: project.verifiedResults.map((result, index) => {
        const annotation = byIndex.get(index);
        return {
          ...result,
          underlyingCorticalRegions: pathRegions[index] ?? annotation?.corticalRegions ?? [],
          deepTargetStructures: annotation?.deepStructures ?? [],
          qcFlags: [
            ...result.qcFlags.filter((flag) => flag !== 'atlas_lookup_pending' && !flag.startsWith('atlas_unavailable')),
            ...(response.atlasVerified ? [] : [response.issue ?? 'atlas_unavailable']),
          ],
        };
      }),
    });
  });
}

app.whenReady().then(async () => {
  registerIpc();
  void startScienceSidecar().catch((error) => console.error('Science sidecar unavailable:', error));
  await createWindow();
  if (headlessSmokeTest) setTimeout(() => app.quit(), 5_000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scienceProcess?.kill();
});
