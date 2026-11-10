/* All styles live inside the shadow root, so the host page can never restyle the tool and the tool never restyles the page. */
export const CSS_TEXT = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.bf { --bf-ink: #14171f; --bf-bg: #ffffff; --bf-muted: #5b6577; --bf-line: #d5dbe6; --bf-soft: #eef1f6; --bf-ok: #15803d; --bf-err: #b91c1c; --bf-accent: #c2410c; --bf-on-accent: #ffffff;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 16px; line-height: 1.4; color: var(--bf-ink); -webkit-text-size-adjust: 100%; }
.bf[data-scheme="dark"] { --bf-ink: #eef1f7; --bf-bg: #1b2030; --bf-muted: #9aa5ba; --bf-line: #38405a; --bf-soft: #262c40; --bf-ok: #4ade80; --bf-err: #f87171; }
@media (prefers-color-scheme: dark) { .bf[data-scheme="auto"] { --bf-ink: #eef1f7; --bf-bg: #1b2030; --bf-muted: #9aa5ba; --bf-line: #38405a; --bf-soft: #262c40; --bf-ok: #4ade80; --bf-err: #f87171; } }
button { font: inherit; color: inherit; }
.fab-wrap { position: fixed; z-index: var(--bf-z, 2147483000); display: flex; align-items:center; gap:8px;
  --ix: calc(16px + var(--bf-x, 0px)); --iy: calc(16px + var(--bf-y, 0px) + var(--bf-ey, 0px)); }
.fab-wrap.bottom-right { right: calc(var(--ix) + env(safe-area-inset-right, 0px)); bottom: calc(var(--iy) + env(safe-area-inset-bottom, 0px)); }
.fab-wrap.bottom-left { left: calc(var(--ix) + env(safe-area-inset-left, 0px)); bottom: calc(var(--iy) + env(safe-area-inset-bottom, 0px)); }
.fab-wrap.top-right { right: calc(var(--ix) + env(safe-area-inset-right, 0px)); top: calc(var(--iy) + env(safe-area-inset-top, 0px)); }
.fab-wrap.top-left { left: calc(var(--ix) + env(safe-area-inset-left, 0px)); top: calc(var(--iy) + env(safe-area-inset-top, 0px)); }
.feedback-start { min-height:48px; display:flex; align-items:center; gap:10px; padding:10px 16px; border:0; border-radius:12px; background:var(--bf-accent); color:var(--bf-on-accent); font-weight:650; cursor:pointer; box-shadow:0 4px 14px rgba(10,14,24,.18); }
.feedback-start svg { width:22px; height:22px; }
.fab { position: relative; width: 48px; height: 48px; border-radius: 50%; border: 2px solid #fff; background: var(--bf-accent); color: var(--bf-on-accent); display: grid; place-items: center; box-shadow: 0 4px 14px rgba(10,14,24,.3); cursor: pointer; padding: 0; }
.fab:focus-visible, .bf button:focus-visible, .bf textarea:focus-visible, .layer:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
.fab svg { width: 24px; height: 24px; }
.count { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: var(--bf-ink); color: var(--bf-bg); font-size: 12px; line-height: 20px; text-align: center; font-weight: 600; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.toast { position: absolute; width: max-content; max-width: min(70vw, 320px); margin: 0; padding: 8px 12px; border-radius: 10px; background: var(--bf-ink); color: var(--bf-bg); font-size: 14px; }
.bottom-right .toast, .top-right .toast { right: 56px; } .bottom-left .toast, .top-left .toast { left: 56px; }
.bottom-right .toast, .bottom-left .toast { bottom: 8px; } .top-right .toast, .top-left .toast { top: 8px; }
.menu { position: absolute; width: min(340px, calc(100vw - 24px)); max-height: min(70vh, 520px); overflow-y: auto; background: var(--bf-bg); color: var(--bf-ink); border: 1px solid var(--bf-line); border-radius: 14px; box-shadow: 0 12px 36px rgba(10,14,24,.3); display: flex; flex-direction: column; }
.bottom-right .menu, .bottom-left .menu { bottom: 58px; } .top-right .menu, .top-left .menu { top: 58px; }
.bottom-right .menu, .top-right .menu { right: 0; } .bottom-left .menu, .top-left .menu { left: 0; }
.menu button.item { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 14px; border: 0; background: none; text-align: left; cursor: pointer; }
.menu button.item svg { width: 18px; height: 18px; flex: none; }
.menu .main { font-weight: 600; border-bottom: 1px solid var(--bf-line); }
.menu .off { color: var(--bf-muted); border-top: 1px solid var(--bf-line); font-size: 14px; }
.list { padding: 8px 14px; }
.list-title { margin: 4px 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--bf-muted); }
.empty { margin: 0 0 6px; font-size: 14px; color: var(--bf-muted); }
.list ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.list li { display: grid; grid-template-columns: 56px 1fr; gap: 10px; align-items: start; }
.thumb { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid var(--bf-line); background: var(--bf-soft); }
.list li strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 14px; font-weight: 500; }
.list li small { display: block; font-size: 13px; color: var(--bf-muted); }
.status { font-style: normal; font-weight: 600; }
.status.is-open { color: var(--bf-accent); } .status.is-fixed { color: var(--bf-ok); } .status.is-wontfix { color: var(--bf-muted); }
.layer { position: fixed; z-index: calc(var(--bf-z, 2147483000) + 1); inset: 0; background: rgba(10,14,24,.5); touch-action: none; cursor: crosshair; user-select: none; -webkit-user-select: none; outline-offset: -4px; }
.rect { position: absolute; border: 2px solid #fff; outline: 2px dashed var(--bf-accent); background: transparent; box-shadow: 0 0 0 100vmax rgba(10,14,24,.55); pointer-events: none; }
.bar { position: absolute; left: 50%; top: calc(env(safe-area-inset-top, 0px) + 8px); transform: translateX(-50%); width: max-content; max-width: calc(100vw - 16px); padding: 8px 10px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; background: #14171f; color: #fff; border-radius: 14px; box-shadow: 0 6px 20px rgba(10,14,24,.4); cursor: default; pointer-events: none; }
.bar > span { flex: 0 1 auto; padding: 0 4px; }
@media (max-width: 600px) { .bar > span { flex: 1 1 100%; text-align: center; } }
.bar button { min-height: 44px; padding: 0 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.5); background: transparent; color: #fff; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; pointer-events: auto; }
.bar button.primary { background: #fff; color: #14171f; font-weight: 600; }
.bar svg { width: 18px; height: 18px; }
.backdrop { position:fixed; z-index:calc(var(--bf-z,2147483000) + 2); left:0; right:0; top:var(--bf-vtop,0px); height:var(--bf-vh,100dvh); background:rgba(10,14,24,.55); display:flex; align-items:flex-end; justify-content:center; }
.sheet { position:relative; width:100%; max-height:100%; min-height:0; background:var(--bf-bg); color:var(--bf-ink); border-radius:16px 16px 0 0; display:flex; flex-direction:column; box-shadow:0 -8px 30px rgba(10,14,24,.2); outline:none; overflow:hidden; }
.sheet > header { padding:8px 16px; flex-shrink:0; border-bottom:1px solid var(--bf-line); }
.sheet-content { display:grid; gap:12px; padding:16px; overflow-y:auto; min-height:0; overscroll-behavior:contain; }
.sheet-actions { padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px)); border-top:1px solid var(--bf-line); background:var(--bf-bg); flex-shrink:0; }
.sheet-actions .send { width:100%; }
.preview-row { display:flex; gap:12px; align-items:center; color:var(--bf-muted); font-size:13px; }
.preview-row .preview { width:64px; height:48px; max-height:48px; margin:0; object-fit:cover; }
.preview-row .link { margin-left:auto; font-size:14px; }
.extras { border-top:1px solid var(--bf-line); padding-top:8px; }
.extras summary { min-height:44px; display:flex; align-items:center; cursor:pointer; color:var(--bf-muted); }
.extras summary::before { content:'+'; margin-right:8px; }
.extras[open] summary::before { content:'−'; }
.extras[open] { display:grid; gap:12px; }
@media(min-width:801px) { .backdrop { align-items:center; padding:24px; } .sheet { width:480px; border-radius:16px; max-height:100%; } }
.sheet > .send { margin:16px; }
.sheet header { display: flex; align-items: center; justify-content: space-between; }
.sheet h2 { margin: 0; font-size: 20px; }
.x { width: 44px; height: 44px; border: 0; background: none; display: grid; place-items: center; cursor: pointer; }
.x svg { width: 20px; height: 20px; }
.preview { display: block; max-width: 100%; max-height: 30vh; max-height: 30dvh; margin: 0 auto; border: 1px solid var(--bf-line); border-radius: 10px; object-fit: contain; background: var(--bf-soft); }
.link { align-self: flex-start; min-height: 44px; padding: 0; border: 0; background: none; color: #2563eb; text-decoration: underline; cursor: pointer; }
.bf[data-scheme="dark"] .link { color: #8ab4ff; }
@media (prefers-color-scheme: dark) { .bf[data-scheme="auto"] .link { color: #8ab4ff; } }
.sheet label { font-weight: 600; }
.sheet textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--bf-line); border-radius: 10px; font: inherit; font-size: 16px; resize: vertical; color: inherit; background: var(--bf-bg); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; border: 0; margin: 0; padding: 0; min-width: 0; }
.chips legend { padding: 0; font-weight: 600; margin-bottom: 6px; }
.chips button { min-height: 44px; padding: 0 14px; border-radius: 22px; border: 1px solid var(--bf-line); background: var(--bf-bg); cursor: pointer; }
.chips button.is-on { background: var(--bf-ink); color: var(--bf-bg); border-color: var(--bf-ink); }
.send { min-height: 48px; border: 0; border-radius: 12px; background: var(--bf-accent); color: var(--bf-on-accent); font-size: 17px; font-weight: 600; cursor: pointer; }
.send:disabled { opacity: .45; cursor: not-allowed; }
.error { margin: 0; color: var(--bf-err); font-size: 15px; }
.sent { display: grid; justify-items: center; gap: 6px; padding: 24px 0; text-align: center; color: var(--bf-ok); } .sent span { color: var(--bf-muted); } .sent svg { width: 28px; height: 28px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
[hidden] { display: none !important; }
.review-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.review-actions a { width: 100%; color: var(--bf-accent); font-size: 13px; padding: 8px 0; }
.review-actions button { border: 1px solid var(--bf-line); border-radius: 8px; background: var(--bf-bg); padding: 8px 10px; min-height: 44px; cursor: pointer; font-size: 13px; }
.review-actions button:disabled { opacity: .5; cursor: wait; }
.adjustment { width: 100%; display: grid; gap: 8px; }
.review-message { padding: 8px; font-size: 13px; }
.status.is-approved { color: var(--bf-ok); }
.status.is-ready_for_review { color: var(--bf-accent); }
@media print { .bf { display: none !important; } }
`;
