import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CortexLumeProjectSchema,
  FitPlacementRequestSchema,
  FitPlacementResponseSchema,
  type CortexLumeProject,
  type FitPlacementRequest,
} from '@cortexlume/contracts';
import { createProjectArchive, readProjectArchive } from './projectArchive';
import { buildBidsGeometryExport, buildCsvExport, type ExportBundle } from './projectExport';

let mainWindow: BrowserWindow | null = null;
let scienceProcess: ChildProcessWithoutNullStreams | null = null;
let sciencePort: number | null = null;
let scienceToken = '';
let scienceReady: Promise<void> | null = null;
const headlessSmokeTest = process.env.CORTEXLUME_HEADLESS_TEST === '1';

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
    show: false,
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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  mainWindow.once('ready-to-show', () => {
    if (!headlessSmokeTest) mainWindow?.show();
  });
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
