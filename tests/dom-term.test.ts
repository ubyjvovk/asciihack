/**
 * DomTerm tests: verify the run-based painter (one span per equal-colour
 * run, not per cell), the shared key mapping (ArrowLeft → 'Left', F5 →
 * 'F5', Ctrl-L → ctrl + 'l'), and that `write()` is a no-op — the browser
 * path uses `paintGrid` via `Screen`. A minimal fake `document` lets the
 * tests run in plain node without jsdom.
 */
import { describe, it, expect } from 'vitest';
import {
  DomTerm,
  buildRunsInto,
  mapKey,
  type DomDocument,
  type DomElement,
  type DomHost,
  type DomKeyboardEvent,
  type DomNode,
} from '../web/src/dom-term.js';
import type { ScreenCell, ScreenGrid } from '../src/model/types.js';

type RGB = [number, number, number];

function cell(ch: string, fg: RGB, bg: RGB = [0, 0, 0]): ScreenCell {
  return { ch, fg, bg };
}

function grid(w: number, h: number, fill: (i: number) => ScreenCell): ScreenGrid {
  const cells = new Array<ScreenCell>(w * h);
  for (let i = 0; i < cells.length; i++) cells[i] = fill(i);
  return { width: w, height: h, cells };
}

// ---------------------------------------------------------------------------
// Minimal DOM doubles

class FakeElement implements DomElement, DomHost {
  ownerDocument: DomDocument;
  clientWidth = 720;
  clientHeight = 432;
  innerHTML = '';
  textContent: string | null = null;
  className = '';
  attrs = new Map<string, string>();
  style = new Proxy({} as Record<string, string>, {}) as unknown as {
    color: string;
    backgroundColor: string;
    [k: string]: string;
  };
  children: DomNode[] = [];
  private keydowns: Array<(e: DomKeyboardEvent) => void> = [];
  private readonly tag: string;

  constructor(tag: string, doc: DomDocument) {
    this.tag = tag;
    this.ownerDocument = doc;
    this.style = { color: '', backgroundColor: '' } as {
      color: string;
      backgroundColor: string;
      [k: string]: string;
    };
    void this.tag;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  appendChild(node: DomNode): void {
    this.children.push(node);
  }
  addEventListener(_type: 'keydown', cb: (e: DomKeyboardEvent) => void): void {
    this.keydowns.push(cb);
  }
  fireKeydown(ev: DomKeyboardEvent): void {
    for (const cb of this.keydowns) cb(ev);
  }
}

class FakeText implements DomNode {
  textContent: string | null;
  constructor(text: string) {
    this.textContent = text;
  }
}

class FakeDoc implements DomDocument {
  createElement(tag: string): DomElement {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string): DomNode {
    return new FakeText(text);
  }
}

function keyEv(key: string, opts: Partial<DomKeyboardEvent> = {}): DomKeyboardEvent {
  return {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    metaKey: opts.metaKey ?? false,
    preventDefault: () => {},
  };
}

// ---------------------------------------------------------------------------
// buildRunsInto — the important behaviour

describe('DomTerm — run-based painting', () => {
  it('a row of equal-colour cells produces exactly one span with the row text', () => {
    const doc = new FakeDoc();
    const row = doc.createElement('div') as FakeElement;
    const g = grid(5, 1, () => cell('a', [255, 255, 255]));
    buildRunsInto(row, doc, g, 0);
    expect(row.children).toHaveLength(1);
    const span = row.children[0] as FakeElement;
    const textNode = span.children[0] as FakeText;
    expect(textNode.textContent).toBe('aaaaa');
    expect(span.style.color).toBe('rgb(255,255,255)');
    expect(span.style.backgroundColor).toBe('rgb(0,0,0)');
  });

  it('two adjacent colour runs produce two spans in order', () => {
    const doc = new FakeDoc();
    const row = doc.createElement('div') as FakeElement;
    const g = grid(4, 1, (i) => (i < 2 ? cell('a', [255, 0, 0]) : cell('b', [0, 255, 0])));
    buildRunsInto(row, doc, g, 0);
    expect(row.children).toHaveLength(2);
    const s1 = row.children[0] as FakeElement;
    const s2 = row.children[1] as FakeElement;
    expect((s1.children[0] as FakeText).textContent).toBe('aa');
    expect(s1.style.color).toBe('rgb(255,0,0)');
    expect((s2.children[0] as FakeText).textContent).toBe('bb');
    expect(s2.style.color).toBe('rgb(0,255,0)');
  });
});

describe('DomTerm — key mapping', () => {
  it('ArrowLeft yields Left with the shared flag defaults', () => {
    const k = mapKey(keyEv('ArrowLeft'));
    expect(k).not.toBeNull();
    expect(k!.key).toBe('Left');
    expect(k!.ctrl).toBe(false);
    expect(k!.shift).toBe(false);
    expect(k!.alt).toBe(false);
  });

  it('F5 (function key) passes through and Escape / Enter are the tokens the App expects', () => {
    expect(mapKey(keyEv('F5'))!.key).toBe('F5');
    expect(mapKey(keyEv('Escape'))!.key).toBe('Escape');
    expect(mapKey(keyEv('Enter'))!.key).toBe('Enter');
  });

  it('Ctrl+L reports lowercase l with ctrl:true (matches src/term/input.ts)', () => {
    const k = mapKey(keyEv('L', { ctrlKey: true }));
    expect(k).not.toBeNull();
    expect(k!.key).toBe('l');
    expect(k!.ctrl).toBe(true);
  });

  it('printable characters (letters + space + punctuation) pass through', () => {
    expect(mapKey(keyEv('k'))!.key).toBe('k');
    expect(mapKey(keyEv(' '))!.key).toBe(' ');
    expect(mapKey(keyEv('>'))!.key).toBe('>');
  });

  it('metaKey (⌘ / Win) is ignored so browser shortcuts still work', () => {
    expect(mapKey(keyEv('r', { metaKey: true }))).toBeNull();
  });
});

describe('DomTerm — TermIO adapter', () => {
  it('paintGrid replaces the host with one row div per grid row and each row holds run spans', () => {
    const doc = new FakeDoc();
    const host = doc.createElement('div') as FakeElement;
    const term = new DomTerm({ host });
    const g = grid(3, 2, (i) => (i < 3 ? cell('a', [1, 2, 3]) : cell('b', [4, 5, 6])));
    term.paintGrid(g);
    expect(host.children).toHaveLength(2);
    for (const rowNode of host.children) {
      const rowEl = rowNode as FakeElement;
      // one run per row (uniform colour within the row)
      expect(rowEl.children).toHaveLength(1);
    }
  });

  it('write() is a no-op so ANSI escapes never leak into the DOM', () => {
    const doc = new FakeDoc();
    const host = doc.createElement('div') as FakeElement;
    const term = new DomTerm({ host });
    host.innerHTML = 'preserve-me';
    term.write('\x1b[2J\x1b[?25l');
    expect(host.innerHTML).toBe('preserve-me');
  });

  it('keydown events delivered through the host reach the onKey callback', () => {
    const doc = new FakeDoc();
    const host = doc.createElement('div') as FakeElement;
    const term = new DomTerm({ host });
    const seen: string[] = [];
    term.onKey((e) => seen.push(e.key));
    host.fireKeydown(keyEv('ArrowRight'));
    host.fireKeydown(keyEv('L', { ctrlKey: true }));
    expect(seen).toEqual(['Right', 'l']);
  });
});
