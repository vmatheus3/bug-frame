import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG, flush, q, reset } from './helpers';

vi.mock('../../src/widget/capture', async () => {
  const real = await vi.importActual<typeof import('../../src/widget/capture')>('../../src/widget/capture');
  return { ...real, captureViewport: async () => PNG, maskImage: async (img: string) => img, cropImage: async () => PNG };
});
import { init, type BugframeInstance } from '../../src/widget/index';

let inst: BugframeInstance | null = null;
const jsonRes = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; init: RequestInit };
function api(role: string | null, calls: Call[] = []) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/access')) return role ? jsonRes({ role }) : jsonRes({ error: 'unauthorized' }, 401);
    if (init.method === 'POST') return jsonRes({ id: 'bug-20260101-000000-abcd', status: 'open' }, 201);
    return jsonRes({ reports: [] });
  });
}
const openMenu = async () => { q('.fab')!.click(); await flush(); };

beforeEach(() => reset());
afterEach(() => { inst?.destroy(); inst = null; });

describe('page analysis menu item', () => {
  it('is hidden for customers and signed-out visitors', async () => {
    for (const role of ['client', null]) {
      inst = init({ enable: 'always', endpoint: '/api/b', fetch: api(role) as unknown as typeof fetch }); await flush();
      await openMenu();
      expect(q('.menu')).toBeTruthy(); expect(q('.menu .analyze')).toBeNull();
      inst.destroy(); inst = null;
    }
  });

  it('is never offered in download mode and download mode never asks for access', async () => {
    const f = vi.fn();
    inst = init({ enable: 'always', fetch: f as unknown as typeof fetch }); await flush();
    await openMenu();
    expect(q('.menu .analyze')).toBeNull(); expect(f).not.toHaveBeenCalled();
  });

  it('administrators get it; one click queues a full-page analysis report and confirms how to run it', async () => {
    const calls: Call[] = [];
    inst = init({ enable: 'always', endpoint: '/api/b', fetch: api('admin', calls) as unknown as typeof fetch }); await flush();
    await openMenu();
    const item = q('.menu .analyze')!;
    expect(item.getAttribute('role')).toBe('menuitem'); expect(item.textContent).toContain('Analyze this page');
    item.click(); await flush();
    const post = calls.find(c => c.init.method === 'POST')!;
    expect(post.url).toBe('/api/b/reports');
    const sent = JSON.parse(String(post.init.body));
    expect(sent).toMatchObject({ kind: 'audit', description: 'Page analysis requested', types: [] });
    expect(sent.full).toMatch(/^data:image\/png/); expect(sent.region).toBe(sent.full); expect(sent.context.region).toEqual({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    expect(q('.sheet')).toBeNull();
    const notice = q('.toast')!; expect(notice.getAttribute('role')).toBe('status'); expect(notice.textContent).toContain('bugframe audit --watch');
  });

  it('runs in the background: the page stays scrollable while the picture is taken, and the message says so', async () => {
    // owner, 2026-11-18: "it starts spinning a wheel and the entire page is frozen ... I have no idea how long it's gonna take"
    let release: (v: string) => void = () => {};
    inst = init({ enable: 'always', endpoint: '/api/b', fetch: api('admin') as unknown as typeof fetch, captureFn: () => new Promise<string>(r => { release = r; }) }); await flush();
    await openMenu(); q('.menu .analyze')!.click(); await flush();
    expect(document.body.style.overflow).not.toBe('hidden'); // the page is usable while the picture is taken
    expect(q('.fab svg.spin')).toBeTruthy(); expect(q('.sheet')).toBeNull();
    release(PNG); await flush();
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(q('.toast')!.textContent).toMatch(/background/i); expect(q('.toast')!.textContent).toMatch(/My requests/);
  });

  it('a late access answer adds the item to an already open menu without rebuilding it', async () => {
    let answer: (r: Response) => void = () => {};
    const f = vi.fn((url: string) => url.endsWith('/access') ? new Promise<Response>(r => { answer = r; }) : Promise.resolve(jsonRes({ reports: [] })));
    inst = init({ enable: 'always', endpoint: '/api/b', fetch: f as unknown as typeof fetch }); await flush();
    await openMenu(); const main = q('.menu .main');
    expect(q('.menu .analyze')).toBeNull();
    answer(jsonRes({ role: 'admin' })); await flush();
    expect(q('.menu .main')).toBe(main); expect(q('.menu .analyze')).toBeTruthy();
  });

  it('a refused analysis shows the access message and sends nothing else', async () => {
    const f = vi.fn(async (url: string, init: RequestInit = {}) => url.endsWith('/access') ? jsonRes({ role: 'admin' }) : init.method === 'POST' ? jsonRes({}, 403) : jsonRes({ reports: [] }));
    inst = init({ enable: 'always', endpoint: '/api/b', locale: 'pt', fetch: f as unknown as typeof fetch }); await flush();
    await openMenu(); expect(q('.menu .analyze')!.textContent).toContain('Analisar esta página');
    q('.menu .analyze')!.click(); await flush();
    expect(q('.toast')!.getAttribute('role')).toBe('alert'); expect(q('.toast')!.textContent).toContain('Entre com uma conta');
  });
});
