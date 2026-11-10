// A small durable outbox: pending delivery is committed in report.json alongside the ticket.
import { createHash, createHmac } from 'node:crypto';
import { summarize } from './util.mjs';

export function createNotifications({ webhook, storage, serial, request = fetch, now = () => new Date(), logger = () => {} }) {
  let timer, running, dirty = false, stopped = false, controller;
  const target = webhook?.url ? createHash('sha256').update(webhook.url).digest('hex') : null;
  if (target) {
    const url = new URL(webhook.url);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(webhook.allowInsecureLocalhost === true && loopback && url.protocol === 'http:')) || url.username || url.password || url.hash) throw new Error('Agent webhooks need HTTPS without embedded credentials or fragments. HTTP loopback requires explicit allowInsecureLocalhost.');
    if (!Number.isInteger(webhook.timeoutMs ?? 5000) || (webhook.timeoutMs ?? 5000) < 1 || (webhook.timeoutMs ?? 5000) > 30000) throw new Error('Webhook timeoutMs must be 1–30000.');
  }
  const pending = report => report.delivery?.target === target && ['pending', 'retrying'].includes(report.delivery.status);
  const initial = report => target ? { eventId: `report.created:${report.id}`, target, status: 'pending', attempts: 0, nextAttemptAt: now().toISOString(), deliveredAt: null } : undefined;
  async function attempt(report) {
    const previous = report.delivery;
    const attempts = previous.attempts + 1, sentAt = now().toISOString();
    const payload = { event: 'report.created', eventId: previous.eventId, sentAt, report: summarize(report), context: report.context };
    if (webhook.includeImages) {
      const region = await storage.readFile(report.id, 'region.png'), full = await storage.readFile(report.id, 'full.png');
      if (region && full) payload.images = { region: region.toString('base64'), full: full.toString('base64') };
    }
    const body = JSON.stringify(payload), headers = { 'content-type': 'application/json', 'user-agent': 'bugframe-webhook', 'idempotency-key': previous.eventId, 'x-bugframe-delivery': previous.eventId };
    if (webhook.secret) headers['x-bugframe-signature'] = 'sha256=' + createHmac('sha256', webhook.secret).update(body).digest('hex');
    controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), webhook.timeoutMs ?? 5000);
    let ok = false, status = null;
    try {
      const response = await request(webhook.url, { method: 'POST', redirect: 'error', headers, body, signal: controller.signal });
      status = response.status; ok = response.ok;
      try { await response.body?.cancel(); } catch { /* response stream already closed */ }
    } catch { /* Save a generic failure only; request errors may contain secrets or receiver URLs. */ }
    finally { clearTimeout(timeout); controller = null; }
    if (stopped) return;
    const failed = !ok && attempts >= 8;
    await serial(report.id, async () => {
      await storage.update(report.id, { delivery: { ...previous, attempts, lastAttemptAt: sentAt, lastStatus: status,
        status: ok ? 'delivered' : failed ? 'failed' : 'retrying',
        deliveredAt: ok ? now().toISOString() : null,
        nextAttemptAt: ok || failed ? null : new Date(now().getTime() + Math.min(300000, 1000 * 2 ** (attempts - 1))).toISOString(),
      } });
    });
    if (!ok) logger('notification', { id: report.id, status: status ?? 'unreachable', attempts });
  }
  async function run() {
    do {
      dirty = false;
      const reports = await storage.list();
      for (const report of reports.filter(report => pending(report) && Date.parse(report.delivery.nextAttemptAt) <= now().getTime()).slice(0, 50)) {
        if (stopped) return; await attempt(report);
      }
    } while (dirty && !stopped);
  }
  const wake = () => {
    if (!target || stopped) return Promise.resolve();
    dirty = true;
    if (!running) running = run().catch(() => logger('notification', { error: 'delivery_store_unavailable' })).finally(() => { running = null; });
    return running;
  };
  const status = async () => {
    if (!target) return { configured: false, pending: 0, failed: 0, delivered: 0, lastDeliveredAt: null };
    const records = (await storage.list()).filter(report => report.delivery?.target === target).map(report => report.delivery);
    return { configured: true, signed: Boolean(webhook.secret), pending: records.filter(record => ['pending', 'retrying'].includes(record.status)).length,
      failed: records.filter(record => record.status === 'failed').length, delivered: records.filter(record => record.status === 'delivered').length,
      lastDeliveredAt: records.map(record => record.deliveredAt).filter(Boolean).sort().at(-1) ?? null };
  };
  async function retry() {
    // Let an in-flight attempt finish before resetting exhausted deliveries.
    await running;
    for (const report of (await storage.list()).filter(report => report.delivery?.target === target && report.delivery.status === 'failed')) {
      await serial(report.id, () => storage.update(report.id, { delivery: { ...report.delivery, status: 'pending', attempts: 0, nextAttemptAt: now().toISOString() } }));
    }
    void wake(); return status();
  }
  if (target) { timer = setInterval(() => { void wake(); }, 1000); timer.unref?.(); queueMicrotask(() => { void wake(); }); }
  return { initial, wake, flush: wake, status, retry, async close() { stopped = true; clearInterval(timer); controller?.abort(); await running; } };
}
