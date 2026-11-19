import { beforeEach, describe, expect, it, vi } from 'vitest';
const seen = vi.hoisted(() => ({ cssText: [] as string[], pseudo: [] as string[], fn: null as unknown }));
vi.mock('html-to-image', () => ({ toPng: async (node: HTMLElement) => {
  const el = node.querySelector('#styled')!; seen.fn = window.getComputedStyle; seen.cssText.push(window.getComputedStyle(el).cssText);
  seen.pseudo.push(window.getComputedStyle(el, '::before').cssText); return 'data:image/png;base64,AA=='; } }));
import { captureViewport, maskRects, selectorList, withComputedCssText } from '../../src/widget/capture';
import { reset } from './helpers';

const box = (el: Element, x: number, y: number, w: number, h: number) => { (el as HTMLElement).getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON() {} }); };
beforeEach(reset);

describe('masking', () => {
  it('covers inputs, passwords, [data-bug-mask] and host selectors, but not buttons, checkboxes or the tool itself', () => {
    document.body.innerHTML = `<input id="a" value="x"><input id="p" type="password"><input id="c" type="checkbox"><input id="s" type="submit"><textarea id="t"></textarea><select id="sel"></select>
      <div id="m" data-bug-mask>secret</div><div id="h" class="host-secret">x</div><div id="plain">hello</div><div data-bug-ui><input id="ui"></div><input id="hidden" value="y">`;
    const ids = ['a', 'p', 'c', 's', 't', 'sel', 'm', 'h', 'plain', 'ui'];
    ids.forEach((id, i) => box(document.getElementById(id)!, 10 + i, 20 + i, 100, 30));
    box(document.getElementById('hidden')!, 0, 0, 0, 0);
    const rects = maskRects({ maskInputs: true, selectors: ['.host-secret'] });
    expect(rects.length).toBe(6); // a, p, t, sel, m, h
    expect(rects[0]).toEqual({ x: 16, y: 26, w: 100, h: 30 }); // explicit marks come first
  });
  it('with maskInputs off only explicit marks are covered', () => {
    document.body.innerHTML = '<input id="a" value="x"><input id="p" type="password"><b id="m" data-bug-mask>s</b>';
    ['a', 'p', 'm'].forEach((id, i) => box(document.getElementById(id)!, i, i, 50, 20));
    expect(maskRects({ maskInputs: false, selectors: [] }).length).toBe(2); // password and data-bug-mask are always covered
  });
  it('ignores invalid selectors instead of throwing', () => {
    document.body.innerHTML = '<b id="m" data-bug-mask>s</b>'; box(document.getElementById('m')!, 0, 0, 5, 5);
    expect(maskRects({ maskInputs: false, selectors: ['[[bad'] }).length).toBe(1);
    expect(selectorList(['.x'])).toBe('[data-bug-mask],input[type="password"],.x');
  });
});

describe('capturing', () => {
  // Safari (every iPhone browser) gives an empty computed cssText, so html-to-image copied ~575 properties one call at a time:
  // 17 s with the page locked on a 500-element page. With a cssText it writes each element's style in one assignment.
  it('hands html-to-image a filled computed cssText during the capture and restores getComputedStyle after', async () => {
    document.body.innerHTML = '<p id="styled" style="color: rgb(1, 2, 3); font-size: 15.5px">x</p>';
    // a browser like Safari or Chrome: computed styles have an empty cssText (jsdom fills it, so take it away)
    const jsdom = window.getComputedStyle;
    const browser = ((el: Element, p?: string | null) => new Proxy(jsdom(el, p), { get: (t, k) => k === 'cssText' ? '' : (v => typeof v === 'function' ? v.bind(t) : v)(Reflect.get(t, k, t)) })) as typeof window.getComputedStyle;
    window.getComputedStyle = browser; seen.cssText = []; seen.pseudo = [];
    try {
      expect(window.getComputedStyle(document.getElementById('styled')!).cssText).toBe('');
      await captureViewport();
      expect(seen.cssText.length).toBeGreaterThan(0);
      for (const text of seen.cssText) { expect(text).toContain('color: rgb(1, 2, 3)'); expect(text).not.toContain('font-size: 15.5px'); } // html-to-image's own font-size rounding (jsdom lists no font-size)
      // ::before/::after keep the browser's own (empty) cssText: html-to-image then copies `content: url(...)` as an image, not text
      expect(seen.pseudo.length).toBeGreaterThan(0); for (const text of seen.pseudo) expect(text).toBe('');
      expect(window.getComputedStyle).toBe(browser); expect(seen.fn).not.toBe(browser);
    } finally { window.getComputedStyle = jsdom; }
  });
  it('restores getComputedStyle even when the capture fails', async () => {
    const real = window.getComputedStyle; document.body.innerHTML = '<p>no #styled here</p>';
    await expect(captureViewport()).rejects.toThrow(); expect(window.getComputedStyle).toBe(real);
  });
});

describe('capturing twice at once', () => {
  it('overlapping captures share one patch and only the last one to finish restores the browser getComputedStyle', () => {
    const real = window.getComputedStyle;
    const first = withComputedCssText(), second = withComputedCssText();
    expect(window.getComputedStyle).not.toBe(real);
    first(); expect(window.getComputedStyle).not.toBe(real); // the other capture is still running
    second(); expect(window.getComputedStyle).toBe(real);
    const again = withComputedCssText(); again(); expect(window.getComputedStyle).toBe(real);
  });
});
