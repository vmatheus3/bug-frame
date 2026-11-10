import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG, flush, q, reset, shadow, tick } from './helpers';

vi.mock('../../src/widget/capture', async () => {
  const real = await vi.importActual<typeof import('../../src/widget/capture')>('../../src/widget/capture');
  return { ...real, captureViewport: async () => PNG, maskImage: async (img: string) => img, cropImage: async () => PNG };
});
import { init, type BugframeInstance, type InitOptions } from '../../src/widget/index';

let inst: BugframeInstance | null = null;
const make = (o: InitOptions = {}) => { inst = init({ enable: 'always', ...o }); return inst; };
const click = (sel: string) => { const el = q(sel); if (!el) throw new Error(`no ${sel}`); el.click(); };
const pointer = (el: Element, type: string, x: number, y: number) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: y, pointerId: 1, button: 0 }));
const jsonRes = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => { reset(); (HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}; (HTMLElement.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {}; });
afterEach(() => { inst?.destroy(); inst = null; });

async function toSheet(o: InitOptions = {}) {
  make(o); click('.feedback-start'); await flush();
  expect(q('.sheet')).toBeTruthy();
}

describe('mounting', () => {
  it('shows nothing until enabled; ?bugs=1 turns it on and persists', () => {
    history.replaceState(null, '', '/?bugs=0'); inst = init({ endpoint: '/api/b' }); expect(document.querySelector('[data-bugframe]')).toBeNull(); inst.destroy();
    history.replaceState(null, '', '/?bugs=1'); inst = init({ endpoint: '/api/b', fetch: async () => jsonRes({ reports: [] }) }); expect(document.querySelector('[data-bugframe]')).toBeTruthy(); inst.destroy();
    history.replaceState(null, '', '/'); inst = init({ endpoint: '/api/b', fetch: async () => jsonRes({ reports: [] }) }); expect(document.querySelector('[data-bugframe]')).toBeTruthy();
  });
  it('the host is marked so screenshots skip it, and styles are isolated in a shadow root', () => {
    make(); const host = document.querySelector('[data-bugframe]')!; expect(host.hasAttribute('data-bug-ui')).toBe(true);
    expect(host.shadowRoot!.querySelector('style')).toBeTruthy(); expect(document.head.querySelector('style')).toBeNull();
  });
  it('enable()/disable()/destroy() mount and unmount', () => {
    inst = init({ enable: 'storage' }); expect(inst.isEnabled()).toBe(false); inst.enable(); expect(document.querySelector('[data-bugframe]')).toBeTruthy(); expect(inst.isEnabled()).toBe(true);
    inst.disable(); expect(document.querySelector('[data-bugframe]')).toBeNull(); inst.enable(); inst.destroy(); expect(document.querySelector('[data-bugframe]')).toBeNull();
  });
  it('positions the button and honours offset, z-index, accent', () => {
    make({ position: 'top-left', offset: { x: 10, y: 20 }, zIndex: 99, accent: '#123456' });
    const wrap = q('.fab-wrap')!; expect(wrap.classList.contains('top-left')).toBe(true); expect(wrap.style.getPropertyValue('--bf-x')).toBe('10px'); expect(wrap.style.getPropertyValue('--bf-y')).toBe('20px');
    expect(q('.bf')!.style.getPropertyValue('--bf-z')).toBe('99'); expect(q('.bf')!.style.getPropertyValue('--bf-accent')).toBe('#123456');
  });
  it('lifts the button above other floating buttons', () => {
    document.body.innerHTML = '<button id="chat">chat</button>';
    const chat = document.getElementById('chat')!; chat.getBoundingClientRect = () => ({ left: window.innerWidth - 70, right: window.innerWidth - 10, top: window.innerHeight - 70, bottom: window.innerHeight - 10, width: 60, height: 60, x: 0, y: 0, toJSON() {} });
    make({ avoid: ['#chat'] }); expect(parseInt(q('.fab-wrap')!.style.getPropertyValue('--bf-ey'))).toBeGreaterThan(40);
  });
  it('uses the localized strings', () => { make({ locale: 'pt' }); expect(q('.bf')!.getAttribute('lang')).toBe('pt'); expect(q('.fab')!.getAttribute('aria-label')).toBe('Meus pedidos'); expect(q('.feedback-start')!.textContent).toContain('Deixar feedback'); });
});

describe('accessibility', () => {
  it('fab is a labelled menu button; menu opens with focus inside and Escape closes it', async () => {
    make(); const fab = q<HTMLButtonElement>('.fab')!; expect(fab.getAttribute('aria-haspopup')).toBe('menu'); expect(fab.getAttribute('aria-expanded')).toBe('false');
    fab.click(); expect(q('.fab')!.getAttribute('aria-expanded')).toBe('true'); expect(shadow().activeElement?.classList.contains('main')).toBe(true);
    q('.fab-wrap')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(q('.menu')).toBeNull();
  });
  it('sheet is a modal dialog with a live region, traps Tab and closes on Escape', async () => {
    await toSheet({ types: ['A'] });
    const sheet = q('.sheet')!; expect(sheet.getAttribute('role')).toBe('dialog'); expect(sheet.getAttribute('aria-modal')).toBe('true'); expect(q('#bf-title')).toBeTruthy();
    expect(q('[role=status]')).toBeTruthy(); expect(q('label')!.getAttribute('for')).toBe('bf-text');
    const last = q('.extras summary')!; last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true); expect(shadow().activeElement).toBe(q('.x'));
    sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(q('.sheet')).toBeNull(); expect(q('.feedback-start')).toBeTruthy();
  });
  it('type chips expose pressed state', async () => {
    await toSheet({ types: ['One', 'Two'] });
    const chip = shadow().querySelectorAll<HTMLButtonElement>('.chips:not(.kinds) button')[1]; expect(chip.getAttribute('aria-pressed')).toBe('false'); chip.click(); expect(chip.getAttribute('aria-pressed')).toBe('true');
  });
  it('types: [] hides the chips', async () => { await toSheet({ types: [] }); expect(q('.chips:not(.kinds)')).toBeNull(); expect(q('.kinds')).toBeTruthy(); });
  it('region can be chosen from the keyboard', async () => {
    make({ selection: 'area' }); click('.feedback-start'); await flush();
    const layer = q('.layer')!; layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); expect(q('.rect')!.style.display).toBe('block');
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush(); expect(q('.sheet')).toBeTruthy();
  });
});

describe('selecting a region', () => {
  it('a drag draws a box and a tap selects a usable area without a precise drag', async () => {
    make({ selection: 'area' }); click('.feedback-start'); await flush();
    const layer = q('.layer')!;
    pointer(layer, 'pointerdown', 10, 10); pointer(layer, 'pointermove', 15, 15); pointer(layer, 'pointerup', 15, 15);
    await flush(); expect(q('.sheet')).toBeTruthy(); click('.preview-row .link');
    const nextLayer = q('.layer')!;
    pointer(nextLayer, 'pointerdown', 20, 30); pointer(nextLayer, 'pointermove', 220, 180); expect(q('.rect')!.style.width).toBe('200px'); pointer(nextLayer, 'pointerup', 220, 180); await flush();
    expect(q('.sheet')).toBeTruthy(); expect(q<HTMLImageElement>('.preview')!.src).toContain('data:image/png');
  });
  it('Cancel and Escape leave without sending', async () => {
    make({ selection: 'area' }); click('.feedback-start'); await flush(); click('.bar button:last-child'); expect(q('.layer')).toBeNull();
    click('.feedback-start'); await flush(); q('.layer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(q('.layer')).toBeNull();
  });
  it('a capture failure shows a message and no layer', async () => {
    const onError = vi.fn(); make({ captureFn: async () => { throw new Error('nope'); }, onError }); click('.fab'); click('.menu .main'); await flush();
    expect(q('.layer')).toBeNull(); expect(q('.toast')!.textContent).toMatch(/could not be captured/); expect(onError).toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('rejects missing endpoints for server-only reporting while preserving explicit download mode', () => {
    expect(() => make({ mode: 'server' })).toThrow(/endpoint/);
    expect(() => make({ allowDownloadFallback: false })).toThrow(/endpoint/);
    expect(() => make({ mode: 'server', endpoint: '   ', allowDownloadFallback: false })).toThrow(/endpoint/);
    expect(document.querySelector('[data-bugframe]')).toBeNull();
    expect(() => make({ mode: 'download', allowDownloadFallback: false })).not.toThrow();
  });
  it.each([401, 403, 413, 429, 500, 503, 'offline'])('retains a strict-server report after %s and retries without downloading', async status => {
    let rejected = true;
    const fetchMock = async (_url: string, options: RequestInit = {}) => {
      if (options.method !== 'POST') return jsonRes({ reports: [] });
      if (!rejected) return jsonRes({ id: 'bug-retried', status: 'open' }, 201);
      if (status === 'offline') throw new TypeError('Network unavailable');
      return jsonRes({}, status as number);
    };
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onSent = vi.fn();
    await toSheet({ endpoint: '/api', mode: 'server', allowDownloadFallback: false, fetch: fetchMock as typeof fetch, onSent });
    const image = q<HTMLImageElement>('.preview')!.src;
    const textarea = q<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'Keep this report'; textarea.dispatchEvent(new Event('input'));
    click('.send'); await flush();
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this report');
    expect(q<HTMLImageElement>('.preview')!.src).toBe(image);
    expect(q('.error')).toBeTruthy(); expect(q('.sent')).toBeNull();
    expect(Array.from(shadow().querySelectorAll('.link')).some(el => el.textContent?.includes('Download'))).toBe(false);
    rejected = false; click('.send'); await flush();
    expect(q('.sent')).toBeTruthy(); expect(onSent).toHaveBeenCalledWith({ id: 'bug-retried', downloaded: false });
    expect(download).not.toHaveBeenCalled();
  });
  it('posts the report with token, reporter id, metadata and optional console errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return init.method === 'POST' ? jsonRes({ id: 'bug-1', status: 'open' }, 201) : jsonRes({ reports: [] }); });
    const onSent = vi.fn();
    await toSheet({ types: ['Wrong layout'], endpoint: '/api/bf/', token: 'pk_1', reporterId: 'user-7', fetch: fetchMock as unknown as typeof fetch, metadata: async () => ({ build: '9.9', mode: 'beta' }), captureConsole: true, onSent });
    console.error('page exploded');
    const ta = q<HTMLTextAreaElement>('textarea')!; const send = q<HTMLButtonElement>('.send')!; expect(send.disabled).toBe(true);
    ta.value = '  The total is wrong  '; ta.dispatchEvent(new Event('input')); expect(send.disabled).toBe(false);
    shadow().querySelectorAll<HTMLButtonElement>('.chips:not(.kinds) button')[0].click();
    send.click(); await flush();
    const post = calls.find(c => c.init.method === 'POST')!;
    expect(post.url).toBe('/api/bf/reports');
    const headers = post.init.headers as Record<string, string>; expect(headers['x-bugframe-token']).toBe('pk_1'); expect(headers['x-bugframe-reporter']).toBe('user-7');
    const body = JSON.parse(post.init.body as string);
    expect(body.description).toBe('The total is wrong'); expect(body.kind).toBe('bug'); expect(body.types).toEqual(['Wrong layout']); expect(body.region).toBe(PNG); expect(body.full).toBe(PNG);
    expect(body.context.metadata).toEqual({ build: '9.9', mode: 'beta' }); expect(body.context.viewport.w).toBe(window.innerWidth); expect(body.context.consoleErrors.some((e: { message: string }) => e.message.includes('page exploded'))).toBe(true);
    expect(onSent).toHaveBeenCalledWith({ id: 'bug-1', downloaded: false }); expect(q('.sent')).toBeTruthy(); expect(q('[role=status]')!.textContent).toMatch(/Sent/);
  });
  it('does not record console errors unless asked', async () => {
    let sent: { context: { consoleErrors: unknown[] } } | null = null;
    const f = async (_u: string, init: RequestInit = {}) => { if (init.method === 'POST') { sent = JSON.parse(init.body as string); return jsonRes({ id: 'bug-2' }, 201); } return jsonRes({ reports: [] }); };
    await toSheet({ endpoint: '/x', fetch: f as unknown as typeof fetch }); console.error('private'); const ta = q<HTMLTextAreaElement>('textarea')!; ta.value = 'x'; ta.dispatchEvent(new Event('input')); q('.send')!.click(); await flush();
    expect(sent!.context.consoleErrors).toEqual([]);
  });
  it('keeps the description and offers a download when sending fails', async () => {
    const f = async (_u: string, init: RequestInit = {}) => (init.method === 'POST' ? jsonRes({ error: 'x' }, 500) : jsonRes({ reports: [] }));
    await toSheet({ endpoint: '/x', fetch: f as unknown as typeof fetch }); const ta = q<HTMLTextAreaElement>('textarea')!; ta.value = 'keep me'; ta.dispatchEvent(new Event('input')); q('.send')!.click(); await flush();
    expect(q('.error')!.textContent).toMatch(/could not be sent/); expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('keep me'); expect(Array.from(shadow().querySelectorAll('.link')).pop()!.textContent).toMatch(/Download/);
  });
  it.each([401, 403])('requires authorized sign-in on %s without offering a ZIP fallback', async status => {
    const f = async (_u: string, options: RequestInit = {}) => options.method === 'POST' ? jsonRes({}, status) : jsonRes({ reports: [] });
    await toSheet({ endpoint: '/api', fetch: f as unknown as typeof fetch });
    const textarea = q<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'Keep my description'; textarea.dispatchEvent(new Event('input')); click('.send'); await flush();
    expect(q('.error')!.textContent).toMatch(/Sign in with an account authorized/);
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('Keep my description');
    expect(Array.from(shadow().querySelectorAll('button')).some(b => b.textContent?.includes('Download as a file'))).toBe(false);
    expect(q('.sent')).toBeNull();
  });
  it('download mode (no endpoint) saves a zip and never calls fetch', async () => {
    const created: Blob[] = []; (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = b => { created.push(b); return 'blob:x'; }; (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const fetchMock = vi.fn(); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); const onSent = vi.fn();
    await toSheet({ fetch: fetchMock as unknown as typeof fetch, onSent }); expect(q('.menu')).toBeNull();
    const ta = q<HTMLTextAreaElement>('textarea')!; ta.value = 'offline report'; ta.dispatchEvent(new Event('input')); q('.send')!.click(); await flush();
    expect(fetchMock).not.toHaveBeenCalled(); expect(click).toHaveBeenCalled(); expect(created[0].type).toBe('application/zip'); expect(created[0].size).toBeGreaterThan(100);
    expect(onSent.mock.calls[0][0].downloaded).toBe(true);
  });
});

describe('my reports', () => {
  it('keeps the report button and menu actions mounted while background reports arrive', async () => {
    let finish: (response: Response) => void = () => {};
    const fetchMock = () => new Promise<Response>(resolve => { finish = resolve; });
    make({ endpoint: '/api', fetch: fetchMock as typeof fetch });
    const fab = q('.fab')!;
    finish(jsonRes({ reports: [] })); await flush();
    expect(q('.fab')).toBe(fab);
    fab.click(); const action = q('.menu .main')!;
    finish(jsonRes({ reports: [] })); await flush();
    expect(q('.menu .main')).toBe(action);
    action.click(); await flush(); expect(q('.sheet')).toBeTruthy();
  });
  it('lists status and fix note, counts open ones, and offers turning the tool off', async () => {
    const reports = [
      { id: 'bug-20260101-000001-aaaa', status: 'open', note: '', createdAt: '2026-01-01', description: 'Button cut off', types: [], page: '/a' },
      { id: 'bug-20260101-000002-bbbb', status: 'fixed', note: 'Widened the button', createdAt: '2026-01-02', description: 'Typo', types: [], page: '/b' },
    ];
    const f = vi.fn(async (u: string) => (u.endsWith('region.png') ? new Response(new Blob(['x'])) : jsonRes({ reports })));
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:thumb';
    make({ endpoint: '/api', enable: 'query', fetch: f as unknown as typeof fetch }); localStorage.setItem('bugframe:enabled', '1'); inst!.enable(); await flush();
    expect(q('.count')!.textContent).toBe('1');
    click('.fab'); await flush(); await tick(10);
    const text = q('.menu')!.textContent!; expect(text).toContain('My requests (2)'); expect(text).toContain('Submitted'); expect(text).toContain('Fixed'); expect(text).toContain('Widened the button');
    expect(q('.menu .off')).toBeTruthy(); click('.menu .off'); expect(document.querySelector('[data-bugframe]')).toBeNull(); expect(localStorage.getItem('bugframe:enabled')).toBeNull();
  });
  it('no turn-off item when always on', () => { make({ endpoint: '/api', fetch: (async () => jsonRes({ reports: [] })) as unknown as typeof fetch }); click('.fab'); expect(q('.menu .off')).toBeNull(); });
});

describe('customer feedback and review', () => {
  it('keeps the description while changing kind and sends structured content changes', async () => {
    const calls: Record<string, unknown>[] = [];
    await toSheet({ endpoint: '/api/b', fetch: (async (_url: string, options: RequestInit = {}) => {
      if (options.method === 'POST') { calls.push(JSON.parse(String(options.body))); return jsonRes({ id: 'feedback', status: 'open' }, 201); }
      return jsonRes({ reports: [] });
    }) as typeof fetch });
    const field = q<HTMLTextAreaElement>('#bf-text')!; field.value = 'Please update our headline'; field.dispatchEvent(new Event('input'));
    shadow().querySelectorAll<HTMLButtonElement>('.kinds button')[1].click();
    expect(q<HTMLTextAreaElement>('#bf-text')!.value).toBe('Please update our headline');
    for (const [selector, value] of [['#bf-currentText', 'Old headline'], ['#bf-suggestedText', 'A clearer headline']]) {
      const input = q<HTMLTextAreaElement>(selector)!; input.value = value; input.dispatchEvent(new Event('input'));
    }
    click('.send'); await flush();
    expect(calls[0]).toMatchObject({ kind: 'content', description: 'Please update our headline', currentText: 'Old headline', suggestedText: 'A clearer headline', types: [] });
  });

  it('responds to a delivered review and clears private requests when access is revoked', async () => {
    let status = 'ready_for_review', revoked = false; const responses: unknown[] = [];
    const request = async (url: string, options: RequestInit = {}) => {
      if (revoked) return jsonRes({}, 401);
      if (url.endsWith('/review')) { responses.push(JSON.parse(String(options.body))); status = 'approved'; return jsonRes({}); }
      if (url.endsWith('.png')) return new Response(new Blob([], { type: 'image/png' }));
      return jsonRes({ reports: [{ id: 'bug-review', status, description: 'Change headline', note: 'Updated. Please check.', types: [], page: '/', reviewVersion: 2 }] });
    };
    make({ endpoint: '/api/b', fetch: request as typeof fetch }); await flush(); click('.fab'); await flush();
    const approve = Array.from(shadow().querySelectorAll('button')).find(button => button.textContent === 'Looks good')!;
    approve.click(); await flush();
    expect(responses).toEqual([{ action: 'approve', reviewVersion: 2, note: '' }]);
    expect(q('.menu')!.textContent).toContain('Approved'); expect(q('.review-actions')).toBeNull();
    revoked = true;
    Array.from(shadow().querySelectorAll('button')).find(button => button.textContent === 'Refresh requests')!.click(); await flush();
    expect(q('.menu')!.textContent).not.toContain('Change headline'); expect(q('.menu')!.textContent).toContain('Sign in with an account authorized');
  });
});
