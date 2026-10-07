import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// 前台是 Vite 專案，root 就是 app/；建置產物進 app/dist（不進 Git），由 server/routes/static.js 直接供應。
// 開發時 `npm run dev:web` 起 Vite dev server，/api 代理到本機工作台（npm run studio，預設 4000）。
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: '/',
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT || 4000}`, changeOrigin: false } },
  },
});
