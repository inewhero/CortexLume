import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Workspace science/geometry code must stay source-linked in development.
  // Prebundling it leaves Vite serving an old optimized copy after core edits,
  // which makes the GUI disagree with the MCP and unit-test implementations.
  optimizeDeps: { exclude: ['@cortexlume/core'] },
  build: {
    sourcemap: true,
    // Three.js publishes its renderer as one indivisible ESM module. After
    // splitting the 2D/3D workspaces and their runtimes, that cached vendor
    // module is the only chunk above Vite's generic 500 kB web-app default.
    chunkSizeWarningLimit: 720,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/three/build/')) return 'three-core';
          if (id.includes('/@react-three/fiber/') || id.includes('/react-reconciler/')) return 'react-three-runtime';
          if (
            id.includes('/@react-three/drei/')
            || id.includes('/three-stdlib/')
            || id.includes('/three-mesh-bvh/')
          ) return 'three-toolkit';
          if (id.includes('/konva/') || id.includes('/react-konva/')) return 'canvas-editor';
          if (
            id.includes('/react/')
            || id.includes('/react-dom/')
            || id.includes('/scheduler/')
            || id.includes('/use-sync-external-store/')
          ) return 'react-runtime';
          return 'vendor';
        },
      },
    },
  },
});
