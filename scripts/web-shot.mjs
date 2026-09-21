#!/usr/bin/env node
// Headless screenshot of a browser-client page — the PM's eyes on the renderer.
// Ported from ~/afterburn/tools/shot.mjs, but driven by Playwright resolved
// from a sibling checkout: Playwright is deliberately NOT a dependency of this
// repo (AGENTS.md: no runtime npm deps, package.json is PM-owned).
//
//   node scripts/web-shot.mjs "<url-or-path>" <out.png> [options]
//
//   <url-or-path>  full URL, or a path like "/scene.html?render=amber"
//                  resolved against --base (default http://127.0.0.1:5173)
//   --w 1280 --h 720     viewport size in CSS px
//   --wait 1200          ms to wait after the ready flag before capturing
//   --ready "expr"       JS polled until truthy (default window.__ready)
//   --noready            do not wait for a ready flag
//   --eval "js"          run in the page before waiting (repeatable)
//   --gpu / --swiftshader  force hardware-ish GPU flags / force software GL
//   --strict             exit 1 on any console error or page error
//
// Always prints console errors, page errors, failed requests, and the value
// of window.__bench?.debugInfo() when the page exposes one.
//
// Needs `npm run web:dev` (and, for `/index.html`, `npm run web:server`).

import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PLAYWRIGHT_DIRS = [
  process.env.PLAYWRIGHT_DIR,
  path.join(homedir(), 'asciicity', 'node_modules'),
  path.join(homedir(), 'afterburn', 'node_modules'),
].filter((d) => typeof d === 'string' && d.length > 0);

function loadPlaywright() {
  for (const dir of PLAYWRIGHT_DIRS) {
    const entry = path.join(dir, 'playwright', 'index.js');
    if (!existsSync(entry)) continue;
    const require = createRequire(path.join(dir, 'noop.js'));
    return require('playwright');
  }
  console.error(
    `web-shot: playwright not found. Looked in:\n  ${PLAYWRIGHT_DIRS.join('\n  ')}\n` +
      'Set PLAYWRIGHT_DIR=<dir containing node_modules/playwright>.',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const pos = [];
  const opt = { base: 'http://127.0.0.1:5173', w: 1280, h: 720, wait: 1200, ready: 'window.__ready', evals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (k === 'strict' || k === 'noready' || k === 'gpu' || k === 'swiftshader') { opt[k] = true; continue; }
    const v = argv[++i];
    if (k === 'eval') opt.evals.push(v);
    else if (['w', 'h', 'wait'].includes(k)) opt[k] = Number(v);
    else opt[k] = v;
  }
  return { pos, opt };
}

const { pos, opt } = parseArgs(process.argv.slice(2));
if (pos.length < 2) {
  console.error('usage: node scripts/web-shot.mjs "<url-or-path>" <out.png> [--w 1280 --h 720 --wait 1200 --gpu --strict]');
  process.exit(2);
}
const url = /^https?:|^file:/.test(pos[0]) ? pos[0] : opt.base + (pos[0].startsWith('/') ? '' : '/') + pos[0];
const out = path.resolve(pos[1]);
mkdirSync(path.dirname(out), { recursive: true });

// WebGPU/WebGL need explicit flags in headless chromium. `--swiftshader` is the
// portable software path (no GPU in a container); `--gpu` asks for the real one.
const gpuArgs = opt.swiftshader
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  args: ['--hide-scrollbars', '--mute-audio', ...gpuArgs],
});
let problems = 0;
const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h }, deviceScaleFactor: 1 });
page.on('console', (m) => {
  if (m.type() === 'error') { problems += 1; console.error(`console.error: ${m.text()}`); }
  else if (m.type() === 'warning') console.error(`console.warn: ${m.text()}`);
});
page.on('pageerror', (e) => { problems += 1; console.error(`pageerror: ${e.message}`); });
page.on('requestfailed', (r) => { problems += 1; console.error(`requestfailed: ${r.url()} — ${r.failure()?.errorText ?? '?'}`); });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
for (const js of opt.evals) await page.evaluate(js);
if (!opt.noready) {
  try {
    await page.waitForFunction(opt.ready, undefined, { timeout: 20_000 });
  } catch {
    problems += 1;
    console.error(`ready expression never became truthy: ${opt.ready}`);
  }
}
await page.waitForTimeout(opt.wait);

const gpu = await page.evaluate(() => {
  const info = { webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator };
  const b = window.__bench;
  if (b && typeof b.debugInfo === 'function') { try { info.debug = b.debugInfo(); } catch (e) { info.debug = String(e); } }
  return info;
});
console.log('page:', JSON.stringify(gpu));

await page.screenshot({ path: out });
console.log(`shot: ${out} (${opt.w}×${opt.h})`);
await browser.close();
process.exit(opt.strict && problems > 0 ? 1 : 0);
