/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { configDefaults } from 'vitest/config';
import { mkdirSync, writeFileSync } from 'node:fs';

// Dev only: lets the page POST a finished export to /__dev/save so it can be inspected with ffprobe (.dev-out/).
const devSave = (): Plugin => ({
  name: 'stickcam-dev-save',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__dev/save', (req, res) => {
      const name = new URL(req.url ?? '', 'http://x').searchParams.get('name')?.replace(/[^\w.-]/g, '_') || 'out.bin';
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        mkdirSync('.dev-out', { recursive: true });
        writeFileSync(`.dev-out/${name}`, Buffer.concat(parts));
        res.end('ok');
      });
    });
  },
});

// Static build: `npm run build` → dist/, deployable on any static host.
// Set BASE=/stickcam/ (for example) when serving from a sub-path such as GitHub Pages project sites.
export default defineConfig({
  base: process.env.BASE ?? './',
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  plugins: [devSave()],
  // Agent worktrees under .claude/ carry their own copies of the tests.
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
