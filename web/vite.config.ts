/**
 * Vite config for the browser client (docs/web.md). Root is `web/`; the WS
 * server lives in `server/ws-server.ts` and is proxied via `/play`. Output
 * goes to `dist-web/` so it never collides with the CLI's `dist/`.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const WS_TARGET = process.env.ASCIIHACK_WS_URL ?? 'ws://127.0.0.1:8790';
/** Dev-server bind address. Defaults to every interface so the page is
 *  reachable from other machines on the LAN; set `ASCIIHACK_WEB_HOST=127.0.0.1`
 *  to go back to loopback only. See docs/web.md "Security". */
const WEB_HOST = process.env.ASCIIHACK_WEB_HOST ?? '0.0.0.0';
/** Dev-server port. 5273, not vite's default 5173, so this project does not
 *  fight the other checkouts on this machine for the port (user, 2026-09-21).
 *  Override with `ASCIIHACK_WEB_PORT`. */
const WEB_PORT = Number(process.env.ASCIIHACK_WEB_PORT ?? '5273');

export default defineConfig({
  root: __dirname,
  server: {
    host: WEB_HOST,
    port: WEB_PORT,
    strictPort: true,
    // Bound on every interface, so requests arrive with whatever Host header
    // the client used (a LAN IP, a Tailscale name). Vite blocks unknown hosts
    // by default; allow them, since the bind address is the real gate here.
    allowedHosts: true,
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
    rollupOptions: {
      // `scene.html` is the standalone renderer bench (web/src/scene-bench.ts):
      // the dungeon with no server, for eyeballing and headless screenshots.
      input: {
        main: resolve(__dirname, 'index.html'),
        scene: resolve(__dirname, 'scene.html'),
        // shipped so the WebGPU backend can be checked on a real browser /
        // real GPU, which headless chromium here cannot do (docs/gpu.md §3)
        gpuProbe: resolve(__dirname, 'gpu-probe.html'),
      },
    },
  },
});
