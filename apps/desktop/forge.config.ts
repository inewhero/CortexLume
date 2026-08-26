import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { ForgeConfig } from '@electron-forge/shared-types';

const execFileAsync = promisify(execFile);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'CortexLume',
    icon: path.resolve(__dirname, 'assets/icon'),
    // CI and offline release builds can point Forge at an already verified
    // electron-v*-win32-x64.zip instead of touching the network.
    ...(process.env.ELECTRON_ZIP_DIR
      ? { electronZipDir: process.env.ELECTRON_ZIP_DIR }
      : {}),
    // Vite bundles every runtime dependency into .vite. Excluding node_modules
    // keeps pnpm workspace junctions out of Electron Packager's ASAR traversal.
    ignore: [/[\\/]node_modules(?:[\\/]|$)/],
    extraResource: [
      path.resolve(__dirname, '../../services/science/dist/cortexlume-science'),
      path.resolve(__dirname, '../../assets'),
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'CortexLume',
      title: 'CortexLume Workstation',
      authors: 'CortexLume',
      description: 'fNIRS layout design and geometrical cortical projection',
      setupIcon: path.resolve(__dirname, 'assets/icon.ico'),
      loadingGif: path.resolve(__dirname, 'assets/install-loading.gif'),
      setupExe: 'CortexLume-Setup.exe',
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts' },
        { entry: 'src/main/mcpBootstrap.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    postMake: async (_forgeConfig, makeResults) => {
      if (process.platform !== 'win32') return makeResults;
      await execFileAsync(process.execPath, [
        path.resolve(__dirname, '../../scripts/repair-squirrel-package.mjs'),
        path.resolve(__dirname, 'out/make/squirrel.windows'),
        path.resolve(__dirname, 'assets/install-loading.gif'),
        path.resolve(__dirname, 'assets/icon.ico'),
      ], { maxBuffer: 8 * 1024 * 1024 });
      return makeResults;
    },
  },
};

export default config;
