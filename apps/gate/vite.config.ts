// Builds the PR overview panel (Custom UI) into dist/panel, which manifest.yml serves as the
// `panel-ui` resource. Runs after scripts/build-app.mjs, which recreates dist/.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./src/frontend', import.meta.url)),
  // Forge serves resources from an app-specific path, so every asset URL must be relative.
  base: './',
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL('./dist/panel', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  logLevel: 'warn',
});
