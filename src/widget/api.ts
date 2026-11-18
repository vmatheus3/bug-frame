import type { FeedbackKind, ReportContext, ReportStatus, ReportSummary } from './types';

export type ApiConfig = { endpoint: string; token?: string; reporterId: string; fetch: typeof fetch };
export type SendPayload = { kind: FeedbackKind; currentText: string; suggestedText: string; description: string; types: string[]; context: ReportContext; region: string; full: string };

const trim = (s: string) => s.replace(/\/+$/, '');
const headers = (c: ApiConfig, json = false): Record<string, string> => ({ ...(c.token ? { 'x-bugframe-token': c.token } : {}), 'x-bugframe-reporter': c.reporterId, ...(json ? { 'content-type': 'application/json' } : {}) });

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function sendReport(c: ApiConfig, body: SendPayload): Promise<{ id: string; status: ReportStatus }> {
  const res = await c.fetch(`${trim(c.endpoint)}/reports`, { method: 'POST', headers: headers(c, true), body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, `Report failed with status ${res.status}`);
  return (await res.json()) as { id: string; status: ReportStatus };
}
/** The verified role of the signed-in account (admin, client); throws on 401/403 like the other calls. */
export async function getAccess(c: ApiConfig): Promise<{ role?: string }> {
  const res = await c.fetch(`${trim(c.endpoint)}/access`, { headers: headers(c), cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, `Access check failed with status ${res.status}`);
  return (await res.json()) as { role?: string };
}
export async function listReports(c: ApiConfig): Promise<ReportSummary[]> {
  const res = await c.fetch(`${trim(c.endpoint)}/reports`, { headers: headers(c), cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, `List failed with status ${res.status}`);
  return ((await res.json()) as { reports: ReportSummary[] }).reports;
}
/** Images need the token header, so they are fetched and shown as object URLs. */
export async function fetchThumb(c: ApiConfig, id: string): Promise<string | null> {
  try {
    const res = await c.fetch(`${trim(c.endpoint)}/reports/${encodeURIComponent(id)}/region.png`, { headers: headers(c) });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}

export async function reviewReport(c: ApiConfig, id: string, action: 'approve' | 'request_changes', reviewVersion: number, note = ''): Promise<void> {
  const res = await c.fetch(`${trim(c.endpoint)}/reports/${encodeURIComponent(id)}/review`, { method: 'POST', headers: headers(c, true), body: JSON.stringify({ action, reviewVersion, note }) });
  if (!res.ok) throw new ApiError(res.status, `Review failed with status ${res.status}`);
}
