import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import squirrelStartupHandled from 'electron-squirrel-startup';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
// The shared contracts package intentionally stays on Zod 3 for broad
// consumer compatibility; use the compatibility entry point here so tuple
// schemas can compose with its schemas without crossing Zod type identities.
import { z as zod } from 'zod/v3';
import {
  ScienceClient,
  type ScienceCommand,
  type ScienceRequestOptions,
  withStagedNiftiFile,
} from '@cortexlume/science-client';
import { isAllowedDevNavigation } from './navigationPolicy';
import { PROJECT_ARCHIVE_LIMITS } from '@cortexlume/project-io';
import {
  CROSS_PROCESS_LIMITS,
  AtlasPathQueryRequestSchema,
  AtlasQueryRequestSchema,
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
  ProjectOperationOptionsSchema,
  ProjectOperationProgressSchema,
  type CortexLumeProject,
  type FitPlacementRequest,
  type ProjectOperationProgress,
  type TargetImportSpace,
  type Vec3,
} from '@cortexlume/contracts';
import { createProjectArchive, readProjectArchive } from './projectArchive';
import {
  buildBidsGeometryExportAsync,
  buildBrainNetExportAsync,
  buildCsvExportAsync,
  type ExportBundle,
  type ExportRunOptions,
} from './projectExport';
import { DIGITIZER_MAX_FILE_BYTES, parseDigitizerFile } from './digitizerImport';
import { annotateProjectAtlas } from './projectAnnotation';
import { fitPlacementWireRequest } from './fitPlacementWire';
import { createTrustedIpcHandler } from './ipcSecurity';
import { ProjectOperationManager, type ProjectOperation } from './projectOperation';
import { checkGithubUpdate } from './startupLifecycle';
import { durableAtomicReplace, stableReadRegularFile } from './durableFile';
import type { UpdateCheckResult } from '../shared/startup';

let mainWindow: BrowserWindow | null = null;
const headlessSmokeTest = process.env.CORTEXLUME_HEADLESS_TEST === '1';
const mcpMode = process.argv.includes('--mcp-stdio');
const squirrelFirstRun = process.argv.includes('--squirrel-firstrun');
const squirrelUninstall = process.argv.includes('--squirrel-uninstall');
const uninstallMode = process.argv.includes('--uninstall-cortexlume');
const installTestMarker = process.env.CORTEXLUME_INSTALL_TEST_MARKER;
const startupProjectPath = process.argv.find((argument, index) => (
  index > 0 && !argument.startsWith('--') && argument.toLowerCase().endsWith('.cortexlume')
)) ?? null;

function getInstallRoot(): string {
  return path.resolve(path.dirname(process.execPath), '..');
}

function getUninstallShortcutPath(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'CortexLume',
    'Uninstall CortexLume.lnk',
  );
}

function removeUninstallShortcut(): void {
  const shortcutPath = getUninstallShortcutPath();
  if (shortcutPath) rmSync(shortcutPath, { force: true });
}

if (squirrelUninstall) removeUninstallShortcut();
let validatedReleaseUrl: string | null = null;
let closeApproved = false;
let closeRequestPending = false;
const authorizedProjectPaths = new Set<string>();
const destinationWrites = new Map<string, Promise<void>>();

function emitProjectProgress(
  operation: ProjectOperation,
  phase: string,
  completed: number,
  total: number,
): void {
  const progress: ProjectOperationProgress = ProjectOperationProgressSchema.parse({
    operationId: operation.id,
    operation: operation.operation,
    phase,
    completed,
    total: Math.max(1, total),
  });
  mainWindow?.webContents.send('operations:progress', progress);
}

const projectOperations = new ProjectOperationManager((progress) => {
  mainWindow?.webContents.send('operations:progress', progress);
});

function checkProjectOperation(operation: ProjectOperation): void {
  projectOperations.check(operation);
}

async function withProjectOperation<T>(
  operation: ProjectOperation['operation'], rawOptions: unknown,
  task: (operation: ProjectOperation) => Promise<T>,
): Promise<T> {
  return projectOperations.run(operation, rawOptions, task);
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
const scienceRequest = <T,>(
  pathname: string,
  payload?: unknown,
  options?: ScienceRequestOptions,
) => scienceClient.request<T>(pathname, payload, options);

async function createWindow(): Promise<void> {
  closeApproved = false;
  closeRequestPending = false;
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
    const isDevNavigation = isAllowedDevNavigation(url, MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!isDevNavigation) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (!headlessSmokeTest) mainWindow?.show();
  });
  mainWindow.on('close', (event) => {
    if (closeApproved) return;
    event.preventDefault();
    if (closeRequestPending) return;
    closeRequestPending = true;
    mainWindow?.webContents.send('window:close-requested');
  });
  mainWindow.once('closed', () => {
    mainWindow = null;
    closeApproved = false;
    closeRequestPending = false;
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

interface WriteGuard {
  signal?: AbortSignal;
  deadline?: number;
}

function checkWriteGuard(options: WriteGuard): void {
  if (options.signal?.aborted) throw new Error('Project export cancelled');
  if (options.deadline != null && Date.now() >= options.deadline) {
    throw new Error('Project export exceeded its overall time budget');
  }
}

async function atomicWrite(
  destination: string,
  data: Uint8Array | string,
  options: WriteGuard = {},
): Promise<void> {
  checkWriteGuard(options);
  const resolved = path.resolve(destination);
  const previous = destinationWrites.get(resolved) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    checkWriteGuard(options);
    await durableAtomicReplace(resolved, data, {
      ensureParent: true,
      beforePublish: () => checkWriteGuard(options),
    });
  });
  destinationWrites.set(resolved, write);
  try {
    await write;
  } finally {
    if (destinationWrites.get(resolved) === write) destinationWrites.delete(resolved);
  }
}

const IPC_RENDERER_ERROR = 'IPC request failed.';
const IPC_DEFAULT_MAX_PAYLOAD_BYTES = CROSS_PROCESS_LIMITS.scienceRequestBytes;
const IPC_SMALL_MAX_PAYLOAD_BYTES = 64 * 1024;

interface TrustedHandleOptions {
  maxPayloadBytes?: number;
}

// Keep the registration wrapper's callback boundary intentionally untyped.
// Inferring z.output<typeof CortexLumeProjectSchema> through every handler
// creates a huge recursive TypeScript instantiation and can exhaust tsc's
// heap; each endpoint still receives runtime validation from its schema.
// The builder is deliberately typed as ``any`` below for the same reason:
// endpoint schemas are validated at runtime, while preserving their full
// recursive Zod output types here makes desktop tsc exceed its heap limit.
const z: any = zod;
interface IpcSchema {
  parse(value: unknown): any;
}
type IpcHandler = (
  event: any,
  args: any,
) => unknown;

/**
 * Register an IPC endpoint with one security/boundary policy.
 *
 * The raw invoke arguments are intentionally serialized before parsing.  This
 * makes the byte budget apply to the actual renderer-to-main payload and,
 * importantly, keeps oversized input away from every side effect in a handler.
 * Errors are logged in the main process with their diagnostic detail while the
 * renderer receives one stable, non-sensitive error message.  The audit record
 * is deliberately limited to channel/outcome/duration/bytes.
 */
function trustedHandle(
  channel: string,
  argsSchema: IpcSchema,
  handler: IpcHandler,
  options: TrustedHandleOptions = {},
): void {
  const maxPayloadBytes = options.maxPayloadBytes ?? IPC_DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
    throw new Error(`Invalid IPC payload limit for ${channel}`);
  }

  ipcMain.handle(channel, createTrustedIpcHandler(
    channel,
    (rawArgs) => argsSchema.parse(rawArgs),
    handler,
    {
      maxPayloadBytes,
      getMainWindow: () => mainWindow,
      logError: (name, error) => console.error(`[ipc:${name}]`, error),
      audit: (record) => console.info(JSON.stringify(record)),
      rendererError: IPC_RENDERER_ERROR,
    },
  ));
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

async function readBoundedFile(filePath: string, maximumBytes: number, label: string): Promise<Buffer> {
  return stableReadRegularFile(filePath, maximumBytes, { label });
}

async function readProjectFile(projectPath: string): Promise<Uint8Array> {
  return readBoundedFile(projectPath, PROJECT_ARCHIVE_LIMITS.compressedBytes, 'Project archive');
}

async function writeExportBundle(
  directory: string,
  bundle: ExportBundle,
  options: Pick<ExportRunOptions, 'signal' | 'deadline' | 'onProgress'> = {},
): Promise<string[]> {
  const files = Object.entries(bundle.files);
  const exportRoot = path.resolve(directory);
  checkWriteGuard(options);
  for (const [index, [filename, content]] of files.entries()) {
    checkWriteGuard(options);
    const destination = path.resolve(exportRoot, filename);
    if (destination !== exportRoot && !destination.startsWith(`${exportRoot}${path.sep}`)) {
      throw new Error(`Invalid export path: ${filename}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    checkWriteGuard(options);
    await atomicWrite(destination, content, options);
    checkWriteGuard(options);
    options.onProgress?.(index + 1, Math.max(1, files.length), 'export-write');
  }
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

function inspectBrainNet(command: string, signal?: AbortSignal): Promise<BrainNetLaunchStatus> {
  const expression = [
    "location=which('BrainNet_MapCfg');",
    "if isempty(location), error('CORTEXLUME_BRAINNET_NOT_FOUND'); end;",
    "surface=fullfile(fileparts(location),'Data','SurfTemplate','BrainMesh_ICBM152.nv');",
    "if ~isfile(surface), error('CORTEXLUME_BRAINNET_SURFACE_NOT_FOUND'); end;",
    "fprintf('CORTEXLUME_BRAINNET_READY %s\\n',location);",
  ].join(' ');
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let settled = false;
    const finish = (result: BrainNetLaunchStatus) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      child?.kill();
      finish({
        matlabFound: false,
        brainNetFound: false,
        launched: false,
        detail: 'MATLAB/BrainNet inspection cancelled.',
      });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child = execFile(command, ['-batch', expression], { timeout: 90_000, windowsHide: true }, (error, stdout, stderr) => {
      const match = stdout.match(/CORTEXLUME_BRAINNET_READY\s+([^\r\n]+)/);
      if (!error && match) {
        finish({ matlabFound: true, brainNetFound: true, launched: false, detail: match[1]!.trim() });
        return;
      }
      const missingExecutable = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      finish({
        matlabFound: !missingExecutable,
        brainNetFound: false,
        launched: false,
        detail: (missingExecutable
          ? 'MATLAB executable was not found. Set CORTEXLUME_MATLAB to matlab.exe.'
          : `${stderr || stdout || error?.message || 'BrainNet Viewer was not found on the MATLAB path.'}`.trim()).slice(-500),
      });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function launchBrainNet(
  command: string,
  scriptPath: string,
  status: BrainNetLaunchStatus,
  signal?: AbortSignal,
): Promise<BrainNetLaunchStatus> {
  const escapedPath = scriptPath.replaceAll("'", "''");
  const expression = `try, run('${escapedPath}'); catch error, disp(getReport(error,'extended')); end`;
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let settled = false;
    const finish = (result: BrainNetLaunchStatus) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      child?.kill();
      finish({ ...status, launched: false, detail: 'MATLAB/BrainNet launch cancelled.' });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child = spawn(command, ['-r', expression], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', (error) => finish({
      ...status, launched: false, detail: `MATLAB failed to start: ${error.message}`,
    }));
    child.once('exit', (code, signal) => finish({
      ...status,
      launched: false,
      detail: `MATLAB exited before BrainNet Viewer could start (${signal ?? code ?? 'unknown'}).`,
    }));
    child.once('spawn', () => {
      setTimeout(() => {
        if (settled) return;
        child.unref();
        finish({ ...status, launched: true, detail: `BrainNet Viewer launched via ${status.detail}` });
      }, 250);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function registerIpc(): void {
  // Cast the large recursive project schema before composing IPC tuples. The
  // runtime parser remains the same, but TypeScript does not retain a fresh
  // full project output type for every handler registration (which otherwise
  // grows desktop tsc beyond its heap limit).
  const projectSaveArgsSchema: IpcSchema = z.tuple([
    CortexLumeProjectSchema as IpcSchema,
    z.string().min(1).optional(),
  ]);
  const projectOperationArgsSchema: IpcSchema = z.tuple([
    CortexLumeProjectSchema as IpcSchema,
    ProjectOperationOptionsSchema.optional(),
  ]);
  const anatomicalCoverageArgsSchema: IpcSchema = z.tuple([
    AnatomicalCoverageRequestSchema as IpcSchema,
  ]);

  trustedHandle('window:minimize', z.tuple([]), async () => mainWindow?.minimize(), {
    maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES,
  });
  trustedHandle('window:toggle-maximize', z.tuple([]), async () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });
  trustedHandle('window:close', z.tuple([]), async () => mainWindow?.close(), {
    maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES,
  });
  trustedHandle('window:finish-close', z.tuple([z.boolean()]), async (_event, [allow]) => {
    closeRequestPending = false;
    if (!allow) return;
    closeApproved = true;
    mainWindow?.close();
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('startup:check-update', z.tuple([]), async () => {
    if (!app.isPackaged) return { status: 'development', currentVersion: app.getVersion() } satisfies UpdateCheckResult;
    const update = await checkGithubUpdate(app.getVersion());
    validatedReleaseUrl = update.status === 'available' ? update.releaseUrl ?? null : null;
    return update;
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('startup:open-release', z.tuple([]), async () => {
    if (!validatedReleaseUrl) return false;
    await shell.openExternal(validatedReleaseUrl);
    return true;
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('project:startup', z.tuple([]), async () => {
    if (!startupProjectPath) return null;
    const selectedPath = path.resolve(startupProjectPath);
    const project = readProjectArchive(await readProjectFile(selectedPath));
    authorizedProjectPaths.add(selectedPath);
    return { project, path: selectedPath };
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('project:open', z.tuple([]), async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open CortexLume project',
      properties: ['openFile'],
      filters: [{ name: 'CortexLume project', extensions: ['cortexlume'] }],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    const project = readProjectArchive(await readProjectFile(selectedPath));
    const resolvedPath = path.resolve(selectedPath);
    authorizedProjectPaths.add(resolvedPath);
    return { project, path: resolvedPath };
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('project:confirm-unsaved', z.tuple([]), async () => {
    const choice = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'Save changes to the current CortexLume project?',
      detail: 'Unsaved changes will be lost if you continue without saving.',
      buttons: ['Save', 'Discard', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return (['save', 'discard', 'cancel'] as const)[choice.response] ?? 'cancel';
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle(
    'project:save',
    projectSaveArgsSchema,
    async (_event, [project, currentPath]) => {
      let destination = currentPath ? path.resolve(currentPath) : undefined;
      if (destination && !authorizedProjectPaths.has(destination)) {
        throw new Error('The renderer is not authorized to overwrite that project path. Use Save As instead.');
      }
      if (!destination) {
        const selection = await dialog.showSaveDialog(mainWindow!, {
          title: 'Save CortexLume project',
          defaultPath: projectFilename(project.name),
          filters: [{ name: 'CortexLume project', extensions: ['cortexlume'] }],
        });
        if (selection.canceled || !selection.filePath) return null;
        destination = ensureProjectExtension(selection.filePath);
      }
      destination = path.resolve(destination);
      await atomicWrite(destination, createProjectArchive(project, app.getVersion()));
      authorizedProjectPaths.add(destination);
      return { path: destination };
    },
    { maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES },
  );

  trustedHandle('input:digitizer', z.tuple([]), async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import 3D digitizer points', properties: ['openFile'],
      filters: [
        { name: 'Digitizer data', extensions: ['csv', 'tsv', 'txt', 'json', 'pos', 'hsp', 'elp', 'eeg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    const bytes = await readBoundedFile(selectedPath, DIGITIZER_MAX_FILE_BYTES, 'Digitizer file');
    return parseDigitizerFile(selectedPath, bytes);
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('input:target-nifti', z.tuple([TargetImportSpaceSchema]), async (_event, [declaredSpace]) => {
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
    // Keep the sidecar request small: the bounded source is copied by the
    // filesystem into its private staging root and removed after processing.
    // This avoids Buffer → base64 → JSON duplication for large maps.
    return withStagedNiftiFile(selectedPath, async (stagedPath, stagedFileName) => {
      const response = await scienceRequest<unknown>('/v1/targets/import', {
        fileName: stagedFileName,
        declaredSpace,
        filePath: stagedPath,
      });
      return TargetImportResultSchema.parse(response);
    });
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('operations:cancel', z.tuple([z.string().trim().min(1).max(128)]), async (_event, [operationId]) => {
    return projectOperations.cancel(operationId);
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('export:csv', projectOperationArgsSchema, async (_event, [project, rawOptions]) =>
    withProjectOperation('export', rawOptions, async (operation) => {
      const directory = await chooseExportDirectory('Export CortexLume CSV files');
      if (!directory) return null;
      checkProjectOperation(operation);
      await mkdir(directory, { recursive: true });
      const runOptions: ExportRunOptions = {
        signal: operation.controller.signal,
        deadline: operation.deadline,
        onProgress: (completed, total, phase) => emitProjectProgress(operation, phase, completed, total),
      };
      const bundle = await buildCsvExportAsync(project, runOptions);
      const files = await writeExportBundle(directory, bundle, runOptions);
      return { directory, files, warnings: bundle.warnings };
    }), { maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES });

  trustedHandle('export:brainnet', projectOperationArgsSchema, async (_event, [project, rawOptions]) =>
    withProjectOperation('export', rawOptions, async (operation) => {
      const directory = await chooseExportDirectory('Export and open in BrainNet Viewer');
      if (!directory) return null;
      checkProjectOperation(operation);
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
      for (const filename of legacyAndGenerated) {
        checkProjectOperation(operation);
        await rm(path.join(directory, filename), { force: true });
      }
      const runOptions: ExportRunOptions = {
        signal: operation.controller.signal,
        deadline: operation.deadline,
        onProgress: (completed, total, phase) => emitProjectProgress(operation, phase, completed, total),
      };
      const bundle = await buildBrainNetExportAsync(project, runOptions);
      const files = await writeExportBundle(directory, bundle, runOptions);
      checkProjectOperation(operation);
      const command = matlabCommand();
      let brainNet = await inspectBrainNet(command, operation.controller.signal);
      const hasCorticalCoordinates = project.verifiedResults.some(
        (result: CortexLumeProject['verifiedResults'][number]) => (
          result.subjectKind === 'optode' && result.corticalRasMm?.every(Number.isFinite)
        ),
      );
      if (brainNet.brainNetFound && hasCorticalCoordinates) {
        checkProjectOperation(operation);
        brainNet = await launchBrainNet(
          command,
          path.join(directory, 'cortexlume_open_brainnet.m'),
          brainNet,
          operation.controller.signal,
        );
      } else if (!hasCorticalCoordinates) {
        brainNet = { ...brainNet, detail: 'Exported files, but no finite cortical optode coordinates were available to load.' };
      }
      const warnings = [
        ...bundle.warnings,
        ...(brainNet.launched ? [] : [brainNet.detail]),
      ];
      return { directory, files, warnings, brainNet };
    }), { maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES });

  trustedHandle('export:bids-geometry', projectOperationArgsSchema, async (_event, [project, rawOptions]) =>
    withProjectOperation('export', rawOptions, async (operation) => {
      const directory = await chooseExportDirectory('Export BIDS-compatible geometry sidecars');
      if (!directory) return null;
      checkProjectOperation(operation);
      await mkdir(directory, { recursive: true });
      const runOptions: ExportRunOptions = {
        signal: operation.controller.signal,
        deadline: operation.deadline,
        onProgress: (completed, total, phase) => emitProjectProgress(operation, phase, completed, total),
      };
      const bundle = await buildBidsGeometryExportAsync(project, runOptions);
      const files = await writeExportBundle(directory, bundle, runOptions);
      return { directory, files, warnings: bundle.warnings };
    }), { maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES });
  trustedHandle('science:health', z.tuple([]), async () => {
    try {
      return await scienceRequest<{
        ok: boolean;
        version?: string;
        applicationVersion?: string;
        sidecarPackageVersion?: string;
        scienceApiVersion?: string;
        gitCommit?: string;
        dependencyLockSha256?: string;
        templateVerified?: boolean;
        atlasVerified?: boolean;
      }>('/v1/health');
    } catch (error) {
      // Health is intentionally a diagnostic endpoint; return a bounded,
      // stable shape while trustedHandle still redacts unexpected failures.
      console.error('[science:health]', error);
      return { ok: false };
    }
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('science:fit-placement', z.tuple([FitPlacementRequestSchema]), async (_event, [request]) => {
    const response = await scienceRequest<unknown>('/v1/placements/fit', fitPlacementWireRequest(request));
    return FitPlacementResponseSchema.parse(response);
  }, { maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES });

  trustedHandle('science:atlas-lookup', z.tuple([
    // Keep the public renderer API compact while validating the wire object
    // consistently with the sidecar request contract.
    z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    z.number().finite().min(0).max(1).optional().default(0),
  ]), async (_event, [point, probabilityThreshold]) => {
    const request = AtlasQueryRequestSchema.parse({
      points: [{ id: 'selection', corticalRasMm: point, deepTargetRasMm: null }],
      probabilityThreshold,
    });
    const response = await scienceRequest<{
      atlasVerified: boolean;
      results: Array<{ corticalRegions: unknown[] }>;
    }>('/v1/atlas/query-batch', request);
    const candidate = response.results[0]?.corticalRegions ?? [];
    return AtlasLabelSchema.array().parse(candidate);
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('science:atlas-lookup-path', z.tuple([
    z.array(z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]))
      .min(1).max(CROSS_PROCESS_LIMITS.maximumPathPointsPerChannel),
    z.number().finite().min(0).max(1).optional().default(0),
  ]), async (_event, [points, probabilityThreshold]) => {
    const request = AtlasPathQueryRequestSchema.parse({ points, probabilityThreshold });
    const response = await scienceRequest<{
      atlasVerified: boolean;
      regions: unknown[];
    }>('/v1/atlas/query-path', request);
    return AtlasLabelSchema.array().parse(response.regions ?? []);
  }, { maxPayloadBytes: CROSS_PROCESS_LIMITS.maximumSerializedRequestBytes });

  trustedHandle('science:annotate-project', projectOperationArgsSchema, async (_event, [project, rawOptions]) =>
    withProjectOperation('annotation', rawOptions, async (operation) => {
      const annotated = await annotateProjectAtlas(project, {
        request: <T,>(pathname: string, payload: unknown, requestOptions?: ScienceRequestOptions) =>
          scienceRequest<T>(pathname, payload, requestOptions),
      }, {
        signal: operation.controller.signal,
        deadline: operation.deadline,
        onProgress: (completed, total, phase) => emitProjectProgress(operation, phase, completed, total),
      });
      return annotated;
    }), { maxPayloadBytes: IPC_DEFAULT_MAX_PAYLOAD_BYTES });

  trustedHandle('science:quick-target-search', z.tuple([
    z.string().trim().max(120).default(''),
    z.number().int().min(1).max(50).optional().default(20),
  ]), async (_event, [query, limit]) => {
    const response = await scienceRequest<{ targets: unknown[]; provenance: Record<string, unknown> }>(
      `/v1/targets?q=${encodeURIComponent(query.trim())}&limit=${limit}`,
    );
    return {
      targets: QuickTargetSummarySchema.array().parse(response.targets),
      provenance: response.provenance ?? {},
    };
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('science:quick-target-map', z.tuple([z.string().trim().min(1).max(160)]), async (_event, [targetId]) => {
    const response = await scienceRequest<unknown>(`/v1/targets/${encodeURIComponent(targetId)}`);
    return FunctionalTargetMapSchema.parse(response);
  }, { maxPayloadBytes: IPC_SMALL_MAX_PAYLOAD_BYTES });

  trustedHandle('science:anatomical-coverage', anatomicalCoverageArgsSchema, async (_event, [request]) => {
    const response = await scienceRequest<unknown>('/v1/coverage/anatomical', request);
    return AnatomicalCoverageAnalysisSchema.parse(response);
  }, { maxPayloadBytes: CROSS_PROCESS_LIMITS.maximumSerializedRequestBytes });
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

async function ensureUninstallShortcut(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const shortcutPath = getUninstallShortcutPath();
  if (!shortcutPath) throw new Error('APPDATA is unavailable; cannot create the uninstall shortcut.');

  const installRoot = getInstallRoot();
  const stableExecutable = path.join(installRoot, 'CortexLume.exe');
  const updateExecutable = path.join(installRoot, 'Update.exe');
  if (!existsSync(stableExecutable) || !existsSync(updateExecutable)) return;

  await mkdir(path.dirname(shortcutPath), { recursive: true });
  const operation = existsSync(shortcutPath) ? 'replace' : 'create';
  const written = shell.writeShortcutLink(shortcutPath, operation, {
    target: stableExecutable,
    args: '--uninstall-cortexlume',
    cwd: installRoot,
    description: 'Uninstall CortexLume Workstation',
    icon: process.execPath,
    iconIndex: 0,
  });
  if (!written) throw new Error(`Failed to create uninstall shortcut: ${shortcutPath}`);
}

async function runUninstallPrompt(): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Uninstall CortexLume Workstation',
    message: 'Uninstall CortexLume Workstation?',
    detail: 'The application and its shortcuts will be removed. Your CortexLume project files will not be deleted.',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) {
    app.quit();
    return;
  }

  removeUninstallShortcut();
  const updateExecutable = path.join(getInstallRoot(), 'Update.exe');
  const child = spawn(updateExecutable, ['--uninstall'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  app.quit();
}

if (!squirrelStartupHandled) app.whenReady().then(async () => {
  if (uninstallMode) {
    await runUninstallPrompt();
    return;
  }
  if (mcpMode) {
    startMcpStdioChild();
    return;
  }
  registerIpc();
  void startScienceSidecar().catch((error) => console.error('Science sidecar unavailable:', error));
  await createWindow();
  await ensureUninstallShortcut().catch((error) => console.error('Uninstall shortcut unavailable:', error));
  if (squirrelFirstRun && installTestMarker) {
    await writeFile(installTestMarker, `${process.execPath}\n`, 'utf8');
  }
  if (squirrelFirstRun && mainWindow && !headlessSmokeTest) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'CortexLume Workstation',
      message: 'CortexLume Workstation is ready.',
      detail: [
        'Desktop and Start Menu shortcuts have been created.',
        `Application files: ${path.dirname(process.execPath)}`,
        'To remove CortexLume, use Uninstall CortexLume in the Start Menu or Windows Installed apps.',
      ].join('\n\n'),
      buttons: ['Start CortexLume', 'Open installation folder'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response === 1) shell.showItemInFolder(process.execPath);
  }
  if (headlessSmokeTest) setTimeout(() => app.quit(), 5_000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!mcpMode && process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopScienceSidecar();
});
