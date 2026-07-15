import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config = {
  packagerConfig: {
    asar: true,
    executableName: 'CortexLume',
    icon: path.resolve(__dirname, 'assets/icon'),
    // CI and offline release builds can point Forge at an already verified
    // electron-v*-win32-x64.zip instead of touching the network.
    electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
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
      authors: 'CortexLume Contributors',
      description: 'fNIRS layout design and geometrical cortical projection',
      setupIcon: path.resolve(__dirname, 'assets/icon.ico'),
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
