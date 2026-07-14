import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import {
  CortexLumeProjectSchema,
  FitPlacementRequestSchema,
  FitPlacementResponseSchema,
  type CortexLumeProject,
  type FitPlacementRequest,
} from '@cortexlume/contracts';

let mainWindow: BrowserWindow | null = null;
let scienceProcess: ChildProcessWithoutNullStreams | null = null;
let sciencePort: number | null = null;
let scienceToken = '';
let scienceReady: Promise<void> | null = null;
const headlessSmokeTest = process.env.CORTEXLUME_HEADLESS_TEST === '1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function projectArchive(project: CortexLumeProject): Uint8Array {
  const manifest = {
    format: project.format,
    formatVersion: project.formatVersion,
    projectId: project.id,
    template: project.template,
  };
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'project.json': strToU8(JSON.stringify(project, null, 2)),
    },
    { level: 6 },
  );
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

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows: unknown[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

async function chooseExportDirectory(title: string): Promise<string | null> {
  const choice = await dialog.showOpenDialog(mainWindow!, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  return choice.canceled ? null : (choice.filePaths[0] ?? null);
}

function resultMap(project: CortexLumeProject): Map<string, CortexLumeProject['verifiedResults'][number]> {
  return new Map(project.verifiedResults.map((result) => [`${result.instanceId ?? ''}:${result.subjectId}`, result]));
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
    const archive = unzipSync(new Uint8Array(await readFile(selectedPath)));
    const projectBytes = archive['project.json'];
    if (!projectBytes) throw new Error('Project archive does not contain project.json');
    return CortexLumeProjectSchema.parse(JSON.parse(decoder.decode(projectBytes)));
  });

  ipcMain.handle(
    'project:save',
    async (_event, rawProject: CortexLumeProject, currentPath?: string) => {
      const project = CortexLumeProjectSchema.parse(rawProject);
      let destination = currentPath;
      if (!destination) {
        const selection = await dialog.showSaveDialog(mainWindow!, {
          title: 'Save CortexLume project',
          defaultPath: `${project.name.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.cortexlume`,
          filters: [{ name: 'CortexLume project', extensions: ['cortexlume'] }],
        });
        if (selection.canceled || !selection.filePath) return null;
        destination = selection.filePath;
      }
      await atomicWrite(destination, projectArchive(project));
      return { path: destination };
    },
  );

  ipcMain.handle('export:csv', async (_event, rawProject: CortexLumeProject) => {
    const project = CortexLumeProjectSchema.parse(rawProject);
    const directory = await chooseExportDirectory('Export CortexLume CSV files');
    if (!directory) return null;
    await mkdir(directory, { recursive: true });
    const results = resultMap(project);
    const optodeRows: unknown[][] = [[
      'layout', 'instance', 'optode', 'type', 'u_mm', 'v_mm',
      'scalp_r', 'scalp_a', 'scalp_s', 'cortex_r', 'cortex_a', 'cortex_s',
      'underlying_cortical_region', 'status', 'qc_flags',
    ]];
    const pairRows: unknown[][] = [[
      'layout', 'pair', 'channel_number', 'source', 'detector', 'nominal_distance_mm', 'short_channel',
      'depth_mm', 'cortex_r', 'cortex_a', 'cortex_s', 'depth_r', 'depth_a', 'depth_s',
      'deep_target_structure', 'status', 'qc_flags',
    ]];
    for (const layout of project.layouts) {
      const instances = project.instances.filter((item) => item.definitionId === layout.id);
      for (const instance of instances) {
        for (const optode of layout.optodes) {
          const result = results.get(`${instance.id}:${optode.id}`);
          optodeRows.push([
            layout.name, instance.id, optode.label, optode.type, ...optode.uvMm,
            ...(result?.scalpRasMm ?? ['', '', '']),
            ...(result?.corticalRasMm ?? ['', '', '']),
            result?.underlyingCorticalRegions[0]?.labelEn ?? '', result?.status ?? '',
            result?.qcFlags.join('|') ?? '',
          ]);
        }
      }
      const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));
      for (const pair of layout.pairs) {
        const firstInstance = project.instances.find((item) => item.definitionId === layout.id);
        const result = results.get(`${firstInstance?.id ?? ''}:${pair.id}`);
        pairRows.push([
          layout.name, pair.id, pair.channelNumber ?? '', byId.get(pair.sourceId)?.label ?? pair.sourceId,
          byId.get(pair.detectorId)?.label ?? pair.detectorId, pair.nominalDistanceMm,
          pair.shortChannel,
          project.projectionSettings.pairDepthOverridesMm[pair.id]
            ?? project.projectionSettings.defaultDepthMm ?? '',
          ...(result?.corticalRasMm ?? ['', '', '']),
          ...(result?.depthTargetRasMm ?? ['', '', '']),
          result?.deepTargetStructures[0]?.labelEn ?? '', result?.status ?? '',
          result?.qcFlags.join('|') ?? '',
        ]);
      }
    }
    await Promise.all([
      atomicWrite(path.join(directory, 'cortexlume_optodes.csv'), encoder.encode(csv(optodeRows))),
      atomicWrite(path.join(directory, 'cortexlume_pairs.csv'), encoder.encode(csv(pairRows))),
    ]);
    return { directory };
  });

  ipcMain.handle('export:bids-geometry', async (_event, rawProject: CortexLumeProject) => {
    const project = CortexLumeProjectSchema.parse(rawProject);
    const directory = await chooseExportDirectory('Export BIDS-compatible geometry sidecars');
    if (!directory) return null;
    await mkdir(directory, { recursive: true });
    const warnings = [
      'This geometry bundle is not a complete BIDS dataset because CortexLume V1 does not create a SNIRF recording.',
    ];
    const results = resultMap(project);
    const optodeRows: unknown[][] = [[
      'name', 'type', 'x', 'y', 'z', 'template_x', 'template_y', 'template_z',
    ]];
    const seen = new Set<string>();
    for (const layout of project.layouts) {
      for (const optode of layout.optodes) {
        if (seen.has(optode.id)) continue;
        seen.add(optode.id);
        const instance = project.instances.find((item) => item.definitionId === layout.id);
        const result = results.get(`${instance?.id ?? ''}:${optode.id}`);
        optodeRows.push([
          optode.label, optode.type, 'n/a', 'n/a', 'n/a',
          ...(result?.scalpRasMm ?? ['n/a', 'n/a', 'n/a']),
        ]);
      }
    }
    await atomicWrite(path.join(directory, 'sub-template_optodes.tsv'), csv(optodeRows).replaceAll(',', '\t'));
    await atomicWrite(
      path.join(directory, 'sub-template_coordsystem.json'),
      JSON.stringify({
        NIRSCoordinateSystem: 'MNI152NLin6Asym',
        NIRSCoordinateUnits: 'mm',
        NIRSCoordinateSystemDescription:
          `Ideal template positions generated by CortexLume with asset ${project.template.assetVersion}.`,
      }, null, 2),
    );

    const profileComplete = project.deviceProfile.wavelengthsNm.length > 0
      && project.deviceProfile.measurementType
      && project.deviceProfile.units;
    if (profileComplete) {
      const channelRows: unknown[][] = [[
        'name', 'type', 'source', 'detector', 'wavelength_nominal', 'units', 'short_channel',
      ]];
      for (const layout of project.layouts) {
        const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));
        for (const pair of layout.pairs) {
          for (const wavelength of project.deviceProfile.wavelengthsNm) {
            channelRows.push([
              `${pair.channelNumber ? `CH${pair.channelNumber}-` : ''}${byId.get(pair.sourceId)?.label}-${byId.get(pair.detectorId)?.label}-${wavelength}`,
              project.deviceProfile.measurementType,
              byId.get(pair.sourceId)?.label,
              byId.get(pair.detectorId)?.label,
              wavelength,
              project.deviceProfile.units,
              pair.shortChannel,
            ]);
          }
        }
      }
      await atomicWrite(path.join(directory, 'sub-template_task-layout_channels.tsv'), csv(channelRows).replaceAll(',', '\t'));
    } else {
      warnings.push('channels.tsv was omitted because wavelengths, measurement type, or units are incomplete.');
    }
    await atomicWrite(path.join(directory, 'README'), warnings.join('\r\n'));
    return { directory, warnings };
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
