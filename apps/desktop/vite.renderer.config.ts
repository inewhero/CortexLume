import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Workspace science/geometry code must stay source-linked in development.
  // Prebundling it leaves Vite serving an old optimized copy after core edits,
  // which makes the GUI disagree with the MCP and unit-test implementations.
  optimizeDeps: { exclude: ['@cortexlume/core'] },
  build: { sourcemap: true },
});
