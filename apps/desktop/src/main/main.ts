import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ScienceClient, type ScienceCommand } from '@cortexlume/science-client';
import {
  CortexLumeProjectSchema,
  AnatomicalCoverageAnalysisSchema,
  AnatomicalCoverageRequestSchema,
  FitPlacementRequestSchema,
  FitPlacementResponseSchema,
  AtlasLabelSchema,
  FunctionalTargetMapSchema,
  QuickTargetSummarySchema,
  TargetImportResultSchema,
  TargetImportSpaceSchema,
  type CortexLumeProject,
  type FitPlacementRequest,
  type TargetImportSpace,
  type Vec3,
} from '@cortexlume/contracts';
import { createProjectArchive, readProjectArchive } from './projectArchive';
import { buildBidsGeometryExport, buildBrainNetExport, buildCsvExport, type ExportBundle } from './projectExport';
import { parseDigitizerFile } from './digitizerImport';
import { mergeProjectAtlasAnnotations, type PathAtlasAnnotation, type PointAtlasAnnotation } from './projectAnnotation';
import { checkGithubUpdate } from './startupLifecycle';
import type { UpdateCheckResult } from '../shared/startup';

let mainWindow: BrowserWindow | null = null;
const headlessSmokeTest = process.env.CORTEXLUME_HEADLESS_TEST === '1';
const mcpMode = process.argv.includes('--mcp-stdio');
const startupProjectPath = process.argv.find((argument, index) => (
  index > 0 && !argument.startsWith('--') && argument.toLowerCase().endsWith('.cortexlume')
)) ?? null;
let validatedReleaseUrl: string | null = null;

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

function resolveTemplateRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'templates', 'MNI152NLin6Asym')
    : path.resolve(app.getAppPath(), '..', '..', 'assets', 'templates', 'MNI152NLin6Asym');
}

function resolveScienceCommand(): ScienceCommand {
  if (app.isPackaged) {
    const executable = path.join(process.resourcesPath, 'cortexlume-science', 'cortexlume-science.exe');
    return { command: executable, args: [], cwd: path.dirname(executable), assetRoot: resolveTemplateRoot() };
  }

  const workspaceRoot = path.resolve(app.getAppPath(), '..', '..');
  const script = path.join(workspaceRoot, 'services', 'science', 'run.py');
  const configuredPython = process.env.CORTEXLUME_PYTHON;
  if (configuredPython) {
    return { command: configuredPython, args: [script], cwd: path.dirname(script), assetRoot: resolveTemplateRoot() };
  }
  // Development must execute the checked-out science source. A previously built
  // sidecar can legitimately lag behind new IPC/API endpoints and is therefore
  // only a fallback when the workspace virtual environment is unavailable.
  const workspacePython = path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe');
  if (existsSync(workspacePython)) {
    return { command: workspacePython, args: [script], cwd: path.dirname(script), assetRoot: resolveTemplateRoot() };
  }
  const builtExecutable = path.resolve(
    workspaceRoot, 'services', 'science', 'dist',
    'cortexlume-science', 'cortexlume-science.exe',
  );
  if (existsSync(builtExecutable)) {
    return { command: builtExecutable, args: [], cwd: path.dirname(builtExecutable), assetRoot: resolveTemplateRoot() };
  }
  return { command: 'py', args: ['-3.12', script], cwd: path.dirname(script), assetRoot: resolveTemplateRoot() };
}

const scienceClient = new ScienceClient(resolveScienceCommand, (message) => console.error(message));
const startScienceSidecar = () => scienceClient.start();
const stopScienceSidecar = () => scienceClient.stop();
const scienceRequest = <T,>(pathname: string, payload?: unknown) => scienceClient.request<T>(pathname, payload);

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

  ipcMain.handle('startup:check-update', async () => {
    if (!app.isPackaged) return { status: 'development', currentVersion: app.getVersion() } satisfies UpdateCheckResult;
    const update = await checkGithubUpdate(app.getVersion());
    validatedReleaseUrl = update.status === 'available' ? update.releaseUrl ?? null : null;
    return update;
  });

  ipcMain.handle('startup:open-release', async () => {
    if (!validatedReleaseUrl) return false;
    await shell.openExternal(validatedReleaseUrl);
    return true;
  });

  ipcMain.handle('project:startup', async () => {
    if (!startupProjectPath) return null;
    const selectedPath = path.resolve(startupProjectPath);
    const project = readProjectArchive(new Uint8Array(await readFile(selectedPath)));
    return { project, path: selectedPath };
  });

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

  ipcMain.handle('input:digitizer', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import 3D digitizer points', properties: ['openFile'],
      filters: [
        { name: 'Digitizer data', extensions: ['csv', 'tsv', 'txt', 'json', 'pos', 'hsp', 'elp', 'eeg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    return parseDigitizerFile(selectedPath, new Uint8Array(await readFile(selectedPath)));
  });

  ipcMain.handle('input:target-nifti', async (_event, rawDeclaredSpace: TargetImportSpace) => {
    const declaredSpace = TargetImportSpaceSchema.parse(rawDeclaredSpace);
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import statistical target map', properties: ['openFile'],
      filters: [
        { name: 'NIfTI statistical map', extensions: ['nii', 'gz'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    const fileName = path.basename(selectedPath);
    if (!fileName.toLowerCase().endsWith('.nii') && !fileName.toLowerCase().endsWith('.nii.gz')) {
      throw new Error('Select a .nii or .nii.gz NIfTI statistical map.');
    }
    if ((await stat(selectedPath)).size > 128 * 1024 * 1024) {
      throw new Error('Target map exceeds the 128 MB import limit.');
    }
    const bytes = await readFile(selectedPath);
    const response = await scienceRequest<unknown>('/v1/targets/import', {
      fileName,
      declaredSpace,
      dataBase64: bytes.toString('base64'),
    });
    return TargetImportResultSchema.parse(response);
  });

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
    const legacyAndGenerated = [
      'cortexlume_brainnet.edge',
      'cortexlume_brainnet_display.node',
      ...[
        '01_left', '02_right', '03_anterior', '04_posterior', '05_dorsal',
        '06_ventral', '06_left_oblique', '07_left_oblique', '07_right_oblique',
        '08_right_oblique', '08_posterior_dorsal', '09_optimized', '10_mosaic',
      ].map((name) => `cortexlume_brainnet_${name}.png`),
    ];
    await Promise.all(legacyAndGenerated.map((filename) => rm(path.join(directory, filename), { force: true })));
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
        corticalRegions: unknown[];
        deepStructures: unknown[];
      }>;
    }>('/v1/atlas/query-batch', {
      points: project.verifiedResults.map((result, index) => ({
        id: String(index),
        corticalRasMm: result.corticalRasMm,
        deepTargetRasMm: result.depthTargetRasMm,
      })),
      probabilityThreshold: project.projectionSettings.atlasProbabilityThreshold,
    });
    const byIndex = new Map<number, PointAtlasAnnotation>(response.results.map((result) => [
      Number(result.id),
      {
        corticalRegions: AtlasLabelSchema.array().parse(result.corticalRegions ?? []),
        deepStructures: AtlasLabelSchema.array().parse(result.deepStructures ?? []),
      },
    ]));
    const pathAnnotations = await Promise.all(project.verifiedResults.map(async (result): Promise<PathAtlasAnnotation | null> => {
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
      return {
        corticalRegions: AtlasLabelSchema.array().parse(pathResponse.regions ?? []),
      };
    }));
    return CortexLumeProjectSchema.parse(mergeProjectAtlasAnnotations(
      project, byIndex, pathAnnotations, response.atlasVerified, response.issue,
    ));
  });

  ipcMain.handle('science:quick-target-search', async (_event, rawQuery: string, rawLimit = 20) => {
    const query = String(rawQuery ?? '').trim().slice(0, 120);
    const limit = Math.max(1, Math.min(50, Math.trunc(Number(rawLimit) || 20)));
    const response = await scienceRequest<{ targets: unknown[]; provenance: Record<string, unknown> }>(
      `/v1/targets?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    return {
      targets: QuickTargetSummarySchema.array().parse(response.targets),
      provenance: response.provenance ?? {},
    };
  });

  ipcMain.handle('science:quick-target-map', async (_event, rawTargetId: string) => {
    const targetId = String(rawTargetId ?? '').trim();
    if (!targetId || targetId.length > 160) throw new Error('Quick Target identifier is invalid.');
    const response = await scienceRequest<unknown>(`/v1/targets/${encodeURIComponent(targetId)}`);
    return FunctionalTargetMapSchema.parse(response);
  });

  ipcMain.handle('science:anatomical-coverage', async (_event, rawRequest: unknown) => {
    const request = AnatomicalCoverageRequestSchema.parse(rawRequest);
    const response = await scienceRequest<unknown>('/v1/coverage/anatomical', request);
    return AnatomicalCoverageAnalysisSchema.parse(response);
  });
}

function startMcpStdioChild(): void {
  const environment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CORTEXLUME_MCP_CHILD: '1',
    CORTEXLUME_APP_ROOT: app.getAppPath(),
    CORTEXLUME_RESOURCES_ROOT: process.resourcesPath,
    CORTEXLUME_APP_VERSION: app.getVersion(),
    CORTEXLUME_IS_PACKAGED: app.isPackaged ? '1' : '0',
  };
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'mcpBootstrap.js'), ...process.argv.slice(1)],
    { stdio: 'inherit', windowsHide: true, env: environment },
  );
  child.once('error', (error) => {
    console.error(`Unable to start CortexLume MCP worker: ${error.message}`);
    app.exit(1);
  });
  child.once('exit', (code) => app.exit(code ?? 1));
}

app.whenReady().then(async () => {
  if (mcpMode) {
    startMcpStdioChild();
    return;
  }
  registerIpc();
  void startScienceSidecar().catch((error) => console.error('Science sidecar unavailable:', error));
  await createWindow();
  if (headlessSmokeTest) setTimeout(() => app.quit(), 5_000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!mcpMode && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopScienceSidecar();
});
