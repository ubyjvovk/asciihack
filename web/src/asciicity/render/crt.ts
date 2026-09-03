/**
 * Retro-terminal CRT overlay: scanlines + vignette + phosphor glow, as a
 * pointer-transparent CSS layer over the canvas. Browser-only (imports CSS).
 */
import './crt.css';

/** Mount the CRT overlay into `parent` and return the outer `.crt` element. */
export function mountCrt(parent: HTMLElement): HTMLElement {
  const doc = parent.ownerDocument;

  const crt = doc.createElement('div');
  crt.className = 'crt';
  crt.setAttribute('aria-hidden', 'true');

  const scan = doc.createElement('div');
  scan.className = 'crt-scan';

  const glow = doc.createElement('div');
  glow.className = 'crt-glow';

  crt.append(scan, glow);
  parent.append(crt);
  return crt;
}

/** Show or hide a mounted CRT overlay without re-creating it. */
export function setCrt(el: HTMLElement, on: boolean): void {
  el.style.display = on ? '' : 'none';
}
