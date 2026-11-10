import { languageUI } from './ui.js';
const $ = id => document.getElementById(id);
const config = JSON.parse(document.body.dataset.config);
const { apiBase, customer, basePath, siteUrl, invitations } = config;
const ui = languageUI(config), t = (key, values) => ui.t(key, values);
$('invitations-panel').hidden = customer || !invitations;
$('agent-panel').hidden = customer;
document.body.dataset.view = customer ? 'customer' : 'developer';
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
$('agent-command').value = `npx bugframe connect codex --remote ${quote(location.origin + apiBase)} --project .${location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? ' --allow-localhost' : ''}`;
let selectedId, selectedReport, rows = [], invitationRows = [], createdInvitation, lastMessage, agentStatus, generation = 0;
const images = new Map();
const statusKey = { open: 'open', reviewed: 'reviewed', in_progress: 'inProgress', ready_for_review: 'ready', changes_requested: 'changesRequested', approved: 'approved', fixed: 'fixed', wontfix: 'notPlanned' };
const statusName = value => t(statusKey[value] ?? 'feedback');
const kindName = value => t(['bug', 'content', 'design', 'idea'].includes(value ?? 'bug') ? value ?? 'bug' : 'feedback');
const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? t('unknownDate') : date.toLocaleString(ui.locale, { dateStyle: 'medium', timeStyle: 'short' }); };
if (customer) { $('history-panel').open = false; $('screenshots-panel').open = false; }
const message = (key, values) => { lastMessage = { key, values }; $('message').textContent = key ? t(key, values) : ''; };
class UiError extends Error { constructor(key, values) { super(key); this.key = key; this.values = values; } }
const showError = error => message(error instanceof UiError ? error.key : 'networkFailed', error?.values);
const releaseImages = () => {
  for (const url of images.values()) URL.revokeObjectURL(url);
  images.clear();
  for (const name of ['region', 'full']) { $(name).removeAttribute('src'); $(name).hidden = true; }
};
const clearPrivateContent = () => {
  delete document.body.dataset.detailOpen; $('back-to-requests').hidden = true;
  generation++; agentStatus = null; $('agent-status').textContent = ''; $('delivery-status').textContent = ''; selectedId = null; selectedReport = null; rows = []; invitationRows = []; createdInvitation = null; releaseImages(); $('detail').hidden = true; $('reports').replaceChildren();
  for (const id of ['description', 'info', 'context', 'resolution', 'customer-note', 'current-text', 'suggested-text', 'invite-expiry']) $(id).textContent = '';
  for (const id of ['note', 'adjustment', 'invite-link', 'invite-email']) $(id).value = '';
  $('invitations').replaceChildren(); $('activity').replaceChildren(); $('invite-result').hidden = true;
  for (const id of ['page-link', 'review-page']) $(id).removeAttribute('href');
};
async function request(route, options = {}) {
  const access = await fetch(apiBase + '/access', { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  if (!access.ok || (!customer && (await access.json()).role !== 'admin')) {
    clearPrivateContent(); throw new UiError(customer ? 'sessionExpired' : 'adminRequired');
  }
  const response = await fetch(apiBase + route, { ...options, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' } });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { clearPrivateContent(); throw new UiError(customer ? 'sessionExpired' : 'adminRequired'); }
    throw new UiError(response.status === 409 ? route.startsWith('/invitations') ? 'alreadyInvited' : 'reviewChanged' : 'requestFailed', { status: response.status });
  }
  return response;
}
function renderRows() {
  $('reports').replaceChildren(); $('empty').hidden = rows.length > 0;
  for (const report of rows) {
    const button = document.createElement('button'); button.type = 'button';
    const title = document.createElement('strong'), meta = document.createElement('small');
    title.className = 'request-title'; title.textContent = report.description; meta.className = 'request-meta'; meta.textContent = `${statusName(report.status)} · ${kindName(report.kind)}`; button.append(title, meta);
    button.dataset.reportId = report.id; button.setAttribute('aria-current', String(report.id === selectedId));
    button.addEventListener('click', () => show(report.id).catch(showError));
    const item = document.createElement('li'); item.append(button); $('reports').append(item);
  }
}
async function refresh() {
  const version = generation;
  const { reports } = await (await request(customer ? '/reports' : '/reports?all=1')).json();
  if (version !== generation) return;
  rows = reports; renderRows();
}
function safePage(report) {
  try {
    const raw = customer ? report.page : report.context.url;
    if (customer && (!raw?.startsWith('/') || raw.startsWith('//'))) return null;
    const page = new URL(raw, location.origin);
    if (['https:', 'http:'].includes(page.protocol) && !page.username && !page.password && (!customer || page.origin === location.origin)) return page.href;
  } catch { /* malformed report links stay hidden */ }
  return null;
}
function renderReportText(report) {
  $('description').textContent = report.description;
  $('info').textContent = `${statusName(report.status)} · ${kindName(report.kind)} · ${dateLabel(report.createdAt)}${customer ? '' : ` · ${report.id} · ${report.context.viewport?.w ?? '?'} × ${report.context.viewport?.h ?? '?'}`}`;
  $('resolution').textContent = report.note ? t('developerNote', { note: report.note }) : '';
  $('customer-note').textContent = report.reviewNote ? t('customerNote', { note: report.reviewNote }) : '';
  $('current-text').textContent = report.currentText || '—'; $('suggested-text').textContent = report.suggestedText || '—';
  $('activity').replaceChildren();
  for (const event of report.activity ?? []) {
    const item = document.createElement('li'); item.textContent = `${statusName(event.status)} · ${t(event.by === 'customer' ? 'customer' : 'developer')} · ${dateLabel(event.at)}${event.note ? ` — ${event.note}` : ''}`; $('activity').append(item);
  }
}
async function show(id) {
  selectedId = id; selectedReport = null; releaseImages(); $('detail').hidden = true;
  const version = generation;
  for (const button of $('reports').querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.reportId === id));
  const report = customer ? rows.find(row => row.id === id) : await (await request('/reports/' + encodeURIComponent(id))).json();
  if (!report || selectedId !== id || version !== generation) return;
  selectedReport = report; document.body.dataset.detailOpen = 'true'; $('back-to-requests').hidden = false; $('detail').hidden = false; $('choose').hidden = true;
  renderReportText(report); $('description').focus();
  const page = safePage(report);
  for (const id of ['page-link', 'review-page']) { $(id).hidden = !page; $(id).removeAttribute('href'); if (page) $(id).href = page; }
  $('context').textContent = customer ? '' : JSON.stringify(report.context, null, 2);
  $('technical').hidden = customer; $('status-form').hidden = customer;
  $('status').value = report.status; $('note').value = report.note; $('save').disabled = report.status === 'approved';
  $('wording').hidden = report.kind !== 'content';
  $('review-form').hidden = !customer || report.status !== 'ready_for_review'; $('adjustment').value = '';
  for (const name of ['region', 'full']) {
    const response = await request(`/reports/${encodeURIComponent(id)}/${name}.png`);
    const blob = await response.blob();
    if (selectedId !== id || version !== generation || blob.type !== 'image/png') return;
    const url = URL.createObjectURL(blob); images.set(name, url); $(name).src = url; $(name).hidden = false;
  }
}
$('status').addEventListener('change', () => { $('save').disabled = $('status').value === 'approved'; });
$('status-form').addEventListener('submit', async event => {
  event.preventDefault(); const id = selectedId;
  if (!id) return;
  if ($('status').value !== 'open' && !$('note').value.trim()) { message('updateNoteRequired'); $('note').focus(); return; }
  $('save').disabled = true;
  try {
    await request('/reports/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: $('status').value, note: $('note').value }) });
    message('statusSaved'); await refresh(); await show(id);
  } catch (error) { showError(error); } finally { $('save').disabled = $('status').value === 'approved'; }
});
async function respond(action) {
  const report = selectedReport; if (!report) return;
  if (action === 'request_changes' && !$('adjustment').value.trim()) { $('adjustment').focus(); message('adjustmentRequired'); return; }
  $('approve').disabled = $('request-changes').disabled = true;
  try {
    await request(`/reports/${encodeURIComponent(report.id)}/review`, { method: 'POST', body: JSON.stringify({ action, reviewVersion: report.reviewVersion, note: $('adjustment').value }) });
    message(action === 'approve' ? 'approvalSaved' : 'adjustmentSent'); await refresh(); await show(report.id);
  } catch (error) { showError(error); } finally { $('approve').disabled = $('request-changes').disabled = false; }
}
$('approve').addEventListener('click', () => respond('approve'));
$('review-form').addEventListener('submit', event => { event.preventDefault(); void respond('request_changes'); });
function renderInvitations() {
  $('invitations').replaceChildren();
  for (const invitation of invitationRows) {
    const item = document.createElement('li'), revoke = document.createElement('button');
    const expired = Date.parse(invitation.expiresAt) <= Date.now();
    item.textContent = `${invitation.email} · ${t(expired ? 'expired' : invitation.status)} · ${t('accessEnds', { date: dateLabel(invitation.expiresAt) })} `;
    if (!expired && invitation.status !== 'revoked') {
      revoke.type = 'button'; revoke.textContent = t('revoke');
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try { await request(`/invitations/${invitation.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'revoked' }) }); await loadInvitations(); }
        catch (error) { showError(error); revoke.disabled = false; }
      }); item.append(revoke);
    }
    $('invitations').append(item);
  }
  if (createdInvitation) $('invite-expiry').textContent = t('inviteExpiry', { date: dateLabel(createdInvitation.expiresAt) });
}
async function loadInvitations() {
  if (customer || !invitations) return;
  const version = generation;
  const result = await (await request('/invitations')).json();
  if (version !== generation) return;
  invitationRows = result.invitations; renderInvitations();
}
$('invite-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('invite-email').validity.valid) { message('invalidEmail'); $('invite-email').focus(); return; }
  const days = Number($('invite-days').value);
  if (!Number.isInteger(days) || days < 1 || days > 30) { message('invalidDuration'); $('invite-days').focus(); return; }
  const version = generation; $('create-invite').disabled = true;
  try {
    const invitation = await (await request('/invitations', { method: 'POST', body: JSON.stringify({ email: $('invite-email').value, expiresInDays: Number($('invite-days').value) }) })).json();
    if (version !== generation) return;
    createdInvitation = { expiresAt: invitation.expiresAt };
    const url = new URL(basePath + '/invite', location.origin); url.hash = new URLSearchParams({ token: invitation.token }).toString();
    $('invite-link').value = url.href; $('invite-result').hidden = false;
    await loadInvitations();
  } catch (error) { showError(error); } finally { $('create-invite').disabled = false; }
});
function renderAgent() { if (!agentStatus) return; $('agent-status').textContent = t(agentStatus.codex?.connected ? 'agentConnected' : 'agentDisconnected'); $('delivery-status').textContent = agentStatus.configured ? t('deliverySummary', agentStatus) : ''; $('retry-notifications').hidden = !agentStatus.failed; }
async function loadAgent() { if (customer) return; const version = generation; const data = await (await request('/agent')).json(); if (version !== generation) return; agentStatus = data; renderAgent(); }
$('retry-notifications').addEventListener('click', async () => { $('retry-notifications').disabled = true; try { await request('/agent/retry', { method: 'POST', body: '{}' }); await loadAgent(); } catch (error) { showError(error); } finally { $('retry-notifications').disabled = false; } });
$('back-to-requests').addEventListener('click', () => { delete document.body.dataset.detailOpen; selectedId = null; selectedReport = null; releaseImages(); $('detail').hidden = true; $('choose').hidden = false; $('back-to-requests').hidden = true; renderRows(); $('reports').querySelector('button')?.focus(); });
async function reload() { await refresh(); if (selectedId) await show(selectedId); await loadInvitations(); await loadAgent(); }
$('refresh').addEventListener('click', () => { message(''); void reload().catch(showError); });
window.addEventListener('pagehide', clearPrivateContent);
window.addEventListener('pageshow', event => { if (event.persisted) reload().catch(showError); });
ui.start(() => {
  $('site-link').href = ui.link(siteUrl); renderRows();
  if (selectedReport) renderReportText(selectedReport);
  renderInvitations(); renderAgent(); if (lastMessage) message(lastMessage.key, lastMessage.values);
});
reload().catch(showError);
