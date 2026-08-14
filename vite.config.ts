import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

function spaFallback(): Plugin {
  return {
    name: 'github-pages-spa-fallback',
    closeBundle() {
      const outputDirectory = path.join(rootDirectory, 'dist');
      copyFileSync(
        path.join(outputDirectory, 'index.html'),
        path.join(outputDirectory, '404.html'),
      );
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), spaFallback()],
  build: {
    target: 'es2022',
  },
});
