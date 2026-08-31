import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const coreSourceEntry = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'cortexlume-webgl-full-reload',
      handleHotUpdate(context) {
        // Fast Refresh can dispose and immediately recreate the R3F Canvas.
        // Three.js intentionally loses the old WebGL context during disposal;
        // affected Windows ANGLE drivers can then invalidate the replacement
        // context as well. Reload the document whenever a changed module feeds
        // HeadViewport, while preserving Fast Refresh for the rest of the UI.
        const queue = [...context.modules];
        const visited = new Set<typeof queue[number]>();
        while (queue.length > 0) {
          const module = queue.pop()!;
          if (visited.has(module)) continue;
          visited.add(module);
          const id = module.id?.replaceAll('\\', '/');
          if (id?.endsWith('/src/renderer/components/HeadViewport.tsx')) {
            context.server.ws.send({ type: 'full-reload', path: '*' });
            return [];
          }
          module.importers.forEach((importer) => queue.push(importer));
        }
        return undefined;
      },
    },
  ],
  base: './',
  resolve: {
    // Resolve the workspace package as application source instead of through
    // its node_modules junction. Vite assigns immutable dependency URLs to
    // junction paths; after core adds a named export, Electron can otherwise
    // reuse the previous transform and fail before React mounts.
    alias: { '@cortexlume/core': coreSourceEntry },
  },
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
