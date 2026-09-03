/**
 * Vite config for the browser client (docs/web.md). Root is `web/`; the WS
 * server lives in `server/ws-server.ts` and is proxied via `/play`. Output
 * goes to `dist-web/` so it never collides with the CLI's `dist/`.
 */
import { defineConfig } from 'vite';

const WS_TARGET = process.env.ASCIIHACK_WS_URL ?? 'ws://127.0.0.1:8790';

export default defineConfig({
  root: __dirname,
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/play': {
        target: WS_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    target: 'es2022',
  },
});
