#!/usr/bin/env node
// Headless screenshot / playtest tool. Gives agents "eyes".
//
//   node tools/shot.mjs <url-or-path> <out.png> [options]
//
// <url-or-path>   full URL, or a path like "/viewer.html?model=ship" (resolved against --base)
// Options:
//   --base http://localhost:5173   dev server origin (default)
//   --w 1600 --h 900 --dpr 1       viewport
//   --wait 2500                    ms to wait after ready before capturing
//   --ready "window.__ready"       JS expression polled until truthy (default: window.__ready, 20s timeout)
//   --noready                      don't wait for a ready flag
//   --eval "js"                    run JS in page before waiting (may be repeated)
//   --script file.mjs              module exporting default async ({page, shot, sleep}) => {}
//                                  shot(name) saves <out-dir>/<name>.png
//   --strict                       exit 1 on page errors / console errors
//   --quiet                        don't echo console.log lines (errors/warnings still shown)
//   --clip x,y,w,h                 capture only a region (CSS px)
//
// Always prints: console errors, page errors, failed requests, and window.__stats if present.

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const pos = [];
  const opt = { base: 'http://localhost:5173', w: 1600, h: 900, dpr: 1, wait: 2500, ready: 'window.__ready', evals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (k === 'strict' || k === 'quiet' || k === 'noready') { opt[k] = true; continue; }
    const v = argv[++i];
    if (k === 'eval') opt.evals.push(v);
    else if (['w', 'h', 'dpr', 'wait'].includes(k)) opt[k] = Number(v);
    else opt[k] = v;
  }
  return { pos, opt };
}

const { pos, opt } = parseArgs(process.argv.slice(2));
if (pos.length < 2) {
  console.error('usage: node tools/shot.mjs <url-or-path> <out.png> [--w 1600 --h 900 --wait 2500 --eval js --script file.mjs --strict]');
  process.exit(2);
}
const url = /^https?:|^file:/.test(pos[0]) ? pos[0] : opt.base + (pos[0].startsWith('/') ? '' : '/') + pos[0];
const out = path.resolve(pos[1]);
fs.mkdirSync(path.dirname(out), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let problems = 0;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-angle=metal',
    '--enable-gpu-rasterization',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${opt.w},${opt.h}`,
  ],
  defaultViewport: { width: opt.w, height: opt.h, deviceScaleFactor: opt.dpr },
});

try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') { problems++; console.log('[console.error]', m.text()); }
    else if (t === 'warn' || t === 'warning') console.log('[console.warn]', m.text());
    else if (!opt.quiet) console.log('[console.' + t + ']', m.text());
  });
  page.on('pageerror', (e) => { problems++; console.log('[pageerror]', e.message); });
  page.on('requestfailed', (r) => { console.log('[requestfailed]', r.url(), r.failure()?.errorText); });
  page.on('response', (r) => { if (r.status() >= 400) { problems++; console.log('[http ' + r.status() + ']', r.url()); } });

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  if (!opt.noready) {
    try {
      await page.waitForFunction(opt.ready, { timeout: 20000, polling: 100 });
    } catch {
      problems++;
      console.log(`[shot] ready flag (${opt.ready}) not set after 20s — capturing anyway`);
    }
  }
  for (const js of opt.evals) {
    const r = await page.evaluate(js);
    if (r !== undefined) console.log('[eval]', JSON.stringify(r));
  }

  const clip = opt.clip ? (([x, y, width, height]) => ({ x, y, width, height }))(opt.clip.split(',').map(Number)) : undefined;
  const shot = async (name) => {
    const file = name.endsWith('.png') ? path.resolve(name) : path.join(path.dirname(out), name + '.png');
    await page.screenshot({ path: file, clip });
    console.log('[shot] saved', file);
    return file;
  };

  if (opt.script) {
    const mod = await import(pathToFileURL(path.resolve(opt.script)).href);
    await mod.default({ page, shot, sleep, opt });
  } else {
    await sleep(opt.wait);
  }
  await page.screenshot({ path: out, clip });
  console.log('[shot] saved', out);

  const stats = await page.evaluate('window.__stats ? JSON.stringify(window.__stats) : null').catch(() => null);
  if (stats) console.log('[stats]', stats);
} finally {
  await browser.close();
}
if (problems) console.log(`[shot] ${problems} problem(s) reported above`);
process.exit(opt.strict && problems ? 1 : 0);
