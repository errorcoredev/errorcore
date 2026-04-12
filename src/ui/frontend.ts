
export function renderHTML(apiToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ErrorCore Dashboard</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23fafafa'/%3E%3Ctext x='16' y='23' text-anchor='middle' fill='%230c0c0c' font-family='system-ui,sans-serif' font-size='20' font-weight='700'%3EE%3C/text%3E%3C/svg%3E" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-primary: #0c0c0c;
      --bg-secondary: #151515;
      --bg-tertiary: #1c1c1c;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text-primary: #ebebeb;
      --text-secondary: rgba(255, 255, 255, 0.56);
      --accent-primary: #fafafa;
      --color-error: #ff6b6b;
      --color-warn: #f7b267;
      --color-success: #57d68d;
      --color-info: #a3a3a3;
      --color-purple: #a78bfa;
      --radius: 8px;
      --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
      --sidebar-width: 56px;
      --font-mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      --font-ui: "Segoe UI", system-ui, sans-serif;
    }
    body { background: var(--bg-primary); color: var(--text-primary); font-family: var(--font-ui); font-size: 14px; overflow: hidden; -webkit-font-smoothing: antialiased; }
    a { color: var(--text-primary); text-decoration: none; }
    a:hover { color: var(--accent-primary); }
    button, a, input, select { transition: background-color 150ms var(--ease-out), border-color 150ms var(--ease-out), color 150ms var(--ease-out); }

    /* ---- App shell ---- */
    .app-shell { display: flex; height: 100vh; overflow: hidden; }

    /* ---- Sidebar ---- */
    .sidebar { width: var(--sidebar-width); flex-shrink: 0; background: var(--bg-secondary); border-right: 1px solid var(--border-subtle); display: flex; flex-direction: column; align-items: center; padding: 14px 0; gap: 2px; }
    .sidebar-logo { width: 32px; height: 32px; margin-bottom: 16px; border-radius: 8px; cursor: default; }
    .sidebar-nav { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%; }
    .sidebar-spacer { flex: 1; }
    .sidebar-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: var(--radius); color: var(--text-secondary); cursor: pointer; border: none; background: none; transition: background-color 150ms var(--ease-out), color 150ms var(--ease-out); }
    .sidebar-icon:hover { background: var(--bg-tertiary); color: var(--text-primary); }
    .sidebar-icon.active { background: var(--bg-tertiary); color: var(--accent-primary); }
    .sidebar-icon svg { display: block; }
    .sidebar-bottom { display: flex; flex-direction: column; align-items: center; gap: 2px; }

    /* ---- Main area ---- */
    .main-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

    /* ---- Top bar ---- */
    .topbar { height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 24px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-primary); flex-shrink: 0; }
    .topbar-title { font-size: 14px; font-weight: 600; color: var(--accent-primary); letter-spacing: -0.02em; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
    .topbar-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.06); font-size: 12px; font-family: var(--font-mono); color: var(--text-secondary); font-weight: 400; }
    .topbar-spacer { flex: 1; }
    .topbar-search { background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.06); border-radius: var(--radius); padding: 6px 12px; color: var(--text-primary); font-size: 13px; font-family: var(--font-ui); outline: none; width: 280px; }
    .topbar-search::placeholder { color: var(--text-secondary); }
    .topbar-search:focus { border-color: var(--border-strong); background: rgba(255,255,255,0.06); }
    .topbar-select { background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.06); border-radius: var(--radius); padding: 6px 12px; color: var(--text-secondary); font-size: 12px; font-family: var(--font-ui); outline: none; cursor: pointer; appearance: none; -webkit-appearance: none; padding-right: 28px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='rgba(255,255,255,0.4)'%3E%3Cpath d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
    .topbar-select:hover { border-color: var(--border-strong); }
    .topbar-select option { background: var(--bg-secondary); color: var(--text-primary); }
    .topbar-btn { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--border-subtle); border-radius: var(--radius); color: var(--text-secondary); cursor: pointer; }
    .topbar-btn:hover { border-color: var(--border-strong); color: var(--accent-primary); }
    .topbar-back { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 13px; cursor: pointer; background: none; border: none; font-family: var(--font-ui); padding: 0; }
    .topbar-back:hover { color: var(--accent-primary); }

    /* ---- Content area ---- */
    .content { flex: 1; overflow-y: auto; padding: 20px 24px; }
    .content::-webkit-scrollbar { width: 6px; }
    .content::-webkit-scrollbar-track { background: transparent; }
    .content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
    .content::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

    /* ---- Histogram ---- */
    .histogram-section { margin-bottom: 20px; }
    .histogram-label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); margin-bottom: 8px; }
    .histogram { width: 100%; height: 56px; display: flex; align-items: flex-end; gap: 1px; }
    .histogram-bar { flex: 1; background: rgba(255,107,107,0.3); border-radius: 2px 2px 0 0; min-height: 1px; transition: background-color 150ms var(--ease-out); cursor: default; }
    .histogram-bar:hover { background: rgba(255,107,107,0.55); }
    .histogram-range { display: flex; justify-content: space-between; font-size: 11px; font-family: var(--font-mono); color: var(--text-secondary); margin-top: 6px; opacity: 0.7; }

    /* ---- Table ---- */
    .table { width: 100%; border-collapse: collapse; }
    .table th { text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 500; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--border-subtle); }
    .table td { padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); font-size: 13px; vertical-align: middle; }
    .table tr.row-main { cursor: pointer; transition: background-color 150ms var(--ease-out); }
    .table tr.row-main:hover { background: rgba(255,255,255,0.03); }
    .table .type-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; font-family: var(--font-mono); }
    .type-Error { background: rgba(255,107,107,0.12); color: var(--color-error); }
    .type-TypeError { background: rgba(247,178,103,0.12); color: var(--color-warn); }
    .type-RangeError { background: rgba(167,139,250,0.12); color: var(--color-purple); }
    .type-default { background: rgba(163,163,163,0.12); color: var(--color-info); }
    .severity-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .msg-truncate { max-width: 440px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .timestamp { color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px; white-space: nowrap; }
    .url-dim { color: var(--text-secondary); font-size: 12px; opacity: 0.7; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .expand-arrow { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; transition: transform 150ms var(--ease-out); color: var(--text-secondary); }
    .expand-arrow.open { transform: rotate(90deg); }

    /* ---- Row expansion ---- */
    .row-expansion td { padding: 0 !important; border-bottom: 1px solid var(--border-subtle); }
    .expansion-inner { padding: 12px 20px 16px 52px; background: var(--bg-secondary); }
    .expansion-stack { background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 10px 12px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; overflow-x: auto; white-space: pre; color: var(--text-secondary); max-height: 140px; overflow-y: hidden; }
    .expansion-stack .frame-app { color: var(--accent-primary); }
    .expansion-actions { margin-top: 10px; display: flex; gap: 12px; align-items: center; }
    .expansion-link { font-size: 12px; color: var(--text-secondary); cursor: pointer; background: none; border: none; font-family: var(--font-ui); padding: 0; }
    .expansion-link:hover { color: var(--accent-primary); }

    /* ---- Pagination ---- */
    .pagination { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; color: var(--text-secondary); font-size: 13px; }
    .pagination button { background: transparent; border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 6px 14px; color: var(--text-secondary); cursor: pointer; font-size: 13px; font-family: var(--font-ui); }
    .pagination button:disabled { opacity: 0.3; cursor: default; }
    .pagination button:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
    .page-info { padding: 6px 0; font-family: var(--font-mono); font-size: 12px; }

    /* ---- Detail view ---- */
    .detail { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius); margin-bottom: 16px; }
    .detail-header { padding: 20px 24px; border-bottom: 1px solid var(--border-subtle); }
    .detail-header h2 { font-size: 16px; color: var(--accent-primary); letter-spacing: -0.03em; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .detail-header .meta { color: var(--text-secondary); font-size: 12px; font-family: var(--font-mono); }

    .section { padding: 16px 24px; border-bottom: 1px solid var(--border-subtle); }
    .section:last-child { border-bottom: none; }
    .section h3 { font-size: 11px; font-weight: 500; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; }
    .section h3:hover { color: var(--text-primary); }

    .stack { background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 12px 14px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; overflow-x: auto; white-space: pre; color: var(--text-secondary); }
    .stack .frame-app { color: var(--accent-primary); }

    .io-item { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
    .io-item:last-child { border-bottom: none; }
    .method-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: var(--font-mono); min-width: 48px; text-align: center; }
    .method-GET { background: rgba(87,214,141,0.12); color: var(--color-success); }
    .method-POST { background: rgba(167,139,250,0.12); color: var(--color-purple); }
    .method-PUT { background: rgba(247,178,103,0.12); color: var(--color-warn); }
    .method-DELETE { background: rgba(255,107,107,0.12); color: var(--color-error); }
    .method-query { background: rgba(163,163,163,0.12); color: var(--color-info); }
    .method-default { background: rgba(255,255,255,0.05); color: var(--text-secondary); }
    .status-chip { padding: 2px 6px; border-radius: 4px; font-size: 11px; font-family: var(--font-mono); }
    .status-2xx { background: rgba(87,214,141,0.12); color: var(--color-success); }
    .status-3xx { background: rgba(247,178,103,0.12); color: var(--color-warn); }
    .status-4xx { background: rgba(255,107,107,0.12); color: var(--color-error); }
    .status-5xx { background: rgba(255,107,107,0.25); color: var(--color-error); }
    .duration-track { width: 80px; height: 8px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
    .duration-bar { height: 100%; border-radius: 4px; min-width: 2px; }
    .duration-bar-normal { background: rgba(255,255,255,0.2); }
    .duration-bar-slow { background: linear-gradient(90deg, var(--color-warn), var(--color-error)); }
    .io-target { color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .io-duration { color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px; min-width: 60px; text-align: right; flex-shrink: 0; }

    .kv-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 20px; font-size: 13px; }
    .kv-grid dt { color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px; }
    .kv-grid dd { color: var(--text-primary); font-family: var(--font-mono); font-size: 12px; word-break: break-all; }

    .raw-json { background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 12px 14px; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; overflow-x: auto; white-space: pre; max-height: 500px; overflow-y: auto; color: var(--text-secondary); }

    /* ---- Stats view ---- */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .stat-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 20px 24px; transition: border-color 150ms var(--ease-out); }
    .stat-card:hover { border-color: var(--border-strong); }
    .stat-card h3 { font-size: 11px; font-weight: 500; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }
    .stat-number { font-size: 36px; font-weight: 700; color: var(--accent-primary); letter-spacing: -0.04em; }
    .stat-list { list-style: none; }
    .stat-list li { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 13px; border-bottom: 1px solid var(--border-subtle); }
    .stat-list li:last-child { border-bottom: none; }
    .stat-count { font-family: var(--font-mono); color: var(--accent-primary); font-size: 13px; }
    .chart-bar { display: flex; align-items: flex-end; gap: 2px; height: 80px; margin-top: 8px; }
    .chart-col { flex: 1; background: rgba(255,107,107,0.35); border-radius: 2px 2px 0 0; min-height: 2px; transition: background-color 150ms var(--ease-out); cursor: default; }
    .chart-col:hover { background: rgba(255,107,107,0.6); }

    .empty-state { text-align: center; padding: 80px 20px; color: var(--text-secondary); }
    .empty-state h2 { font-size: 18px; color: var(--text-primary); margin-bottom: 8px; font-weight: 600; letter-spacing: -0.02em; }

    @media (max-width: 768px) {
      .sidebar { display: none; }
      .topbar-search { width: 160px; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import { h, render, Component } from 'https://esm.sh/preact@10.25.4';
    import { useState, useEffect } from 'https://esm.sh/preact@10.25.4/hooks';
    import htm from 'https://esm.sh/htm@3.1.1';
    const html = htm.bind(h);

    function escapeHtml(s) {
      if (typeof s !== 'string') return s == null ? '' : String(s);
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
    }
    const API_TOKEN = ${apiToken ? `'${apiToken.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : 'null'};
    const authHeaders = API_TOKEN ? { 'Authorization': 'Bearer ' + API_TOKEN } : {};

    function typeClass(t) {
      return ['Error','TypeError','RangeError'].includes(t) ? 'type-'+t : 'type-default';
    }
    function severityColor(t) {
      const m = { Error: 'var(--color-error)', TypeError: 'var(--color-warn)', RangeError: 'var(--color-purple)' };
      return m[t] || 'var(--color-info)';
    }
    function methodClass(m) {
      return ['GET','POST','PUT','DELETE','query'].includes(m) ? 'method-'+m : 'method-default';
    }
    function statusClass(s) {
      if (!s) return '';
      if (s < 300) return 'status-2xx';
      if (s < 400) return 'status-3xx';
      if (s < 500) return 'status-4xx';
      return 'status-5xx';
    }
    function fmtTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
    }
    function fmtDuration(ms) {
      if (ms === null || ms === undefined) return '';
      if (ms < 1) return '<1ms';
      if (ms < 1000) return Math.round(ms) + 'ms';
      return (ms/1000).toFixed(2) + 's';
    }
    function highlightStack(stack) {
      if (!stack) return '';
      return stack.split('\\n').map(line => {
        const isApp = !line.includes('node_modules') && (line.includes('.ts:') || line.includes('.js:') || line.includes('.tsx:'));
        return html\`<span class=\${isApp ? 'frame-app' : ''}>\${line}\\n</span>\`;
      });
    }
    function truncateStack(stack, lines) {
      if (!stack) return '';
      const arr = stack.split('\\n').slice(0, lines);
      return arr.map(line => {
        const isApp = !line.includes('node_modules') && (line.includes('.ts:') || line.includes('.js:') || line.includes('.tsx:'));
        return html\`<span class=\${isApp ? 'frame-app' : ''}>\${line}\\n</span>\`;
      });
    }

    /* ---- Icons ---- */
    const IconLogo = () => html\`<svg width="28" height="28" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="7" fill="#fafafa"/><text x="16" y="23" text-anchor="middle" fill="#0c0c0c" font-family="system-ui,sans-serif" font-size="19" font-weight="700">E</text></svg>\`;
    const IconErrors = () => html\`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><line x1="10" y1="6.5" x2="10" y2="11"/><circle cx="10" cy="13.5" r="0.75" fill="currentColor" stroke="none"/></svg>\`;
    const IconStats = () => html\`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="10" width="3" height="7" rx="0.5"/><rect x="8.5" y="5" width="3" height="12" rx="0.5"/><rect x="14" y="8" width="3" height="9" rx="0.5"/></svg>\`;
    const IconSettings = () => html\`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.5"/><path d="M10 3v2M10 15v2M4 10h2M14 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M5.4 14.6l1.4-1.4M13.2 6.8l1.4-1.4"/></svg>\`;
    const IconRefresh = () => html\`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 0 1 9.27-4"/><path d="M13.5 8a5.5 5.5 0 0 1-9.27 4"/><polyline points="12 1.5 12.5 4.5 9.5 4"/><polyline points="4 14.5 3.5 11.5 6.5 12"/></svg>\`;
    const IconChevron = () => html\`<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M4.5 2.5l4 3.5-4 3.5z"/></svg>\`;
    const IconBack = () => html\`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="13" y1="8" x2="3" y2="8"/><polyline points="7 4 3 8 7 12"/></svg>\`;

    /* ---- Sidebar ---- */
    function Sidebar({ view, setView }) {
      return html\`<aside class="sidebar">
        <div class="sidebar-logo"><\${IconLogo} /></div>
        <div class="sidebar-nav">
          <button class="sidebar-icon \${view === 'list' || view === 'detail' ? 'active' : ''}" onClick=\${() => setView('list')} title="Errors"><\${IconErrors} /></button>
          <button class="sidebar-icon \${view === 'stats' ? 'active' : ''}" onClick=\${() => setView('stats')} title="Statistics"><\${IconStats} /></button>
        </div>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-bottom">
          <button class="sidebar-icon" title="Settings" disabled style="opacity:0.4;cursor:default"><\${IconSettings} /></button>
        </div>
      </aside>\`;
    }

    /* ---- Top bar ---- */
    function TopBar({ view, setView, search, setSearch, sort, setSort, total, onSearch, onRefresh }) {
      if (view === 'detail') {
        return html\`<div class="topbar">
          <button class="topbar-back" onClick=\${() => setView('list')}><\${IconBack} /> Error Detail</button>
        </div>\`;
      }
      if (view === 'stats') {
        return html\`<div class="topbar">
          <div class="topbar-title">Statistics</div>
        </div>\`;
      }
      return html\`<div class="topbar">
        <div class="topbar-title">Errors \${total > 0 ? html\`<span class="topbar-badge">\${total}</span>\` : ''}</div>
        <div class="topbar-spacer"></div>
        <form onSubmit=\${onSearch} style="display:contents">
          <input class="topbar-search" type="text" placeholder="Search errors..." value=\${search} onInput=\${e => setSearch(e.target.value)} />
        </form>
        <select class="topbar-select" value=\${sort} onChange=\${e => { setSort(e.target.value); }}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </select>
        <button class="topbar-btn" type="button" onClick=\${onRefresh} title="Refresh"><\${IconRefresh} /></button>
      </div>\`;
    }

    /* ---- Mini histogram ---- */
    function MiniHistogram({ data }) {
      if (!data) return null;
      const hours = Object.entries(data).sort(([a],[b]) => a.localeCompare(b));
      if (hours.length === 0) return null;
      const maxCount = Math.max(...hours.map(([,c]) => c), 1);
      return html\`<div class="histogram-section">
        <div class="histogram-label">Error volume</div>
        <div class="histogram">
          \${hours.map(([hour, count]) => html\`
            <div class="histogram-bar" style="height:\${Math.max(3, (count/maxCount)*100)}%" title="\${hour}: \${count}"></div>
          \`)}
        </div>
        <div class="histogram-range">
          <span>\${hours[0]?.[0] || ''}</span>
          <span>\${hours[hours.length-1]?.[0] || ''}</span>
        </div>
      </div>\`;
    }

    /* ---- App ---- */
    function App() {
      const [view, setView] = useState('list');
      const [errors, setErrors] = useState([]);
      const [total, setTotal] = useState(0);
      const [page, setPage] = useState(1);
      const [search, setSearch] = useState('');
      const [sort, setSort] = useState('newest');
      const [detail, setDetail] = useState(null);
      const [stats, setStats] = useState(null);
      const [hourlyData, setHourlyData] = useState(null);
      const [expanded, setExpanded] = useState({});
      const limit = 25;

      function fetchErrors() {
        const params = new URLSearchParams({ page, limit, sort });
        if (search) params.set('search', search);
        fetch('/api/errors?' + params, { headers: authHeaders }).then(r => r.json()).then(data => {
          setErrors(data.entries); setTotal(data.total);
        });
      }
      function fetchHourly() {
        fetch('/api/stats', { headers: authHeaders }).then(r => r.json()).then(data => {
          setHourlyData(data.byHour);
        }).catch(() => {});
      }
      function fetchStats() {
        fetch('/api/stats', { headers: authHeaders }).then(r => r.json()).then(setStats);
      }
      function openDetail(id) {
        fetch('/api/errors/' + id, { headers: authHeaders }).then(r => r.json()).then(data => {
          setDetail(data); setView('detail');
        });
      }
      function toggleExpand(id, e) {
        e.stopPropagation();
        setExpanded(prev => {
          const next = { ...prev };
          if (next[id]) { delete next[id]; } else { next[id] = true; }
          return next;
        });
      }

      useEffect(() => { if (view === 'list') { fetchErrors(); fetchHourly(); } }, [page, sort, view]);
      useEffect(() => { if (view === 'stats') fetchStats(); }, [view]);

      function doSearch(e) { e.preventDefault(); setPage(1); fetchErrors(); }
      function doRefresh() { fetch('/api/refresh', {method:'POST', headers: {...authHeaders, 'X-ErrorCore-Action': 'true'}}).then(() => { fetchErrors(); fetchHourly(); }); }

      const listContent = errors.length === 0
        ? html\`<div class="empty-state">
            <h2>No errors captured yet</h2>
            <p>Errors will appear here once errorcore captures them.</p>
          </div>\`
        : html\`
          <\${MiniHistogram} data=\${hourlyData} />
          <table class="table">
            <thead><tr>
              <th style="width:36px"></th>
              <th>Timestamp</th>
              <th>Severity</th>
              <th>Message</th>
              <th>URL</th>
            </tr></thead>
            <tbody>\${errors.map(e => {
              const isOpen = !!expanded[e.id];
              return html\`
                <tr key=\${e.id} class="row-main" onClick=\${(ev) => toggleExpand(e.id, ev)}>
                  <td style="width:36px;text-align:center"><span class="expand-arrow \${isOpen ? 'open' : ''}"><\${IconChevron} /></span></td>
                  <td class="timestamp">\${fmtTime(e.capturedAt)}</td>
                  <td><span class="type-badge \${typeClass(e.errorType)}"><span class="severity-dot" style="background:\${severityColor(e.errorType)}"></span>\${e.errorType}</span></td>
                  <td class="msg-truncate">\${e.errorMessage}</td>
                  <td class="url-dim">\${e.url || '\\u2014'}</td>
                </tr>
                \${isOpen ? html\`<tr class="row-expansion"><td colspan="5">
                  <div class="expansion-inner">
                    <div class="expansion-stack">\${truncateStack(e.stack, 5)}</div>
                    <div class="expansion-actions">
                      <button class="expansion-link" onClick=\${(ev) => { ev.stopPropagation(); openDetail(e.id); }}>View full detail \\u2192</button>
                    </div>
                  </div>
                </td></tr>\` : null}
              \`;
            })}</tbody>
          </table>
          <div class="pagination">
            <span>\${total} error\${total !== 1 ? 's' : ''}</span>
            <div style="display:flex;gap:8px;align-items:center">
              <button disabled=\${page <= 1} onClick=\${() => setPage(p => p-1)}>Prev</button>
              <span class="page-info">\${page} / \${Math.ceil(total/limit) || 1}</span>
              <button disabled=\${page >= Math.ceil(total/limit)} onClick=\${() => setPage(p => p+1)}>Next</button>
            </div>
          </div>\`;

      return html\`<div class="app-shell">
        <\${Sidebar} view=\${view} setView=\${setView} />
        <div class="main-area">
          <\${TopBar} view=\${view} setView=\${setView} search=\${search} setSearch=\${setSearch} sort=\${sort} setSort=\${(v) => { setSort(v); setPage(1); }} total=\${total} onSearch=\${doSearch} onRefresh=\${doRefresh} />
          <div class="content">
            \${view === 'detail' && detail ? html\`<\${DetailView} pkg=\${detail} />\`
              : view === 'stats' ? html\`<\${StatsView} stats=\${stats} />\`
              : listContent}
          </div>
        </div>
      </div>\`;
    }

    /* ---- Detail view ---- */
    function DetailView({ pkg }) {
      const [showRaw, setShowRaw] = useState(false);
      const [collapsed, setCollapsed] = useState({});
      const toggle = (s) => setCollapsed(c => ({...c, [s]: !c[s]}));

      const io = pkg.ioTimeline || [];
      const maxDur = Math.max(...io.map(e => e.durationMs || 0), 1);
      const meta = pkg.processMetadata || {};
      const env = pkg.environment || {};
      const comp = pkg.completeness || {};
      const req = pkg.request;

      return html\`
        <div class="detail">
          <div class="detail-header">
            <h2><span class="type-badge \${typeClass(pkg.error?.type)}">\${escapeHtml(pkg.error?.type)}</span> \${escapeHtml(pkg.error?.message)}</h2>
            <div class="meta">\${fmtTime(pkg.capturedAt)}\${req ? ' \\u2014 ' + escapeHtml(req.method + ' ' + req.url) : ''}</div>
          </div>

          <div class="section">
            <h3 onClick=\${() => toggle('stack')}>\${collapsed.stack ? '\\u25b6' : '\\u25bc'} Stack Trace</h3>
            \${!collapsed.stack && html\`<div class="stack">\${highlightStack(pkg.error?.stack)}</div>\`}
            \${!collapsed.stack && pkg.error?.rawStack && html\`
              <details style="margin-top:8px"><summary style="color:var(--text-secondary);font-size:12px;cursor:pointer">Raw (unresolved) stack</summary>
              <div class="stack" style="margin-top:4px">\${pkg.error.rawStack}</div></details>\`}
          </div>

          \${io.length > 0 && html\`<div class="section">
            <h3 onClick=\${() => toggle('io')}>\${collapsed.io ? '\\u25b6' : '\\u25bc'} IO Timeline (\${io.length})</h3>
            \${!collapsed.io && io.map(ev => html\`
              <div class="io-item">
                <span class="method-badge \${ev.type === 'db-query' ? 'method-query' : methodClass(ev.method || '')}">\${ev.type === 'db-query' ? (ev.method || 'query') : (ev.method || ev.type)}</span>
                <span class="io-target">\${escapeHtml(ev.url || ev.target)}\${ev.dbMeta?.query ? ' \\u2014 ' + escapeHtml(ev.dbMeta.query) : ''}</span>
                \${ev.statusCode ? html\`<span class="status-chip \${statusClass(ev.statusCode)}">\${ev.statusCode}</span>\` : ''}
                <span class="io-duration">\${fmtDuration(ev.durationMs)}</span>
                <div class="duration-track"><div class="duration-bar \${(ev.durationMs || 0) > 500 ? 'duration-bar-slow' : 'duration-bar-normal'}" style="width:\${Math.max(2, (ev.durationMs||0)/maxDur*80)}px"></div></div>
              </div>
            \`)}
          </div>\`}

          \${req && html\`<div class="section">
            <h3 onClick=\${() => toggle('req')}>\${collapsed.req ? '\\u25b6' : '\\u25bc'} Request Context</h3>
            \${!collapsed.req && html\`<dl class="kv-grid">
              <dt>Method</dt><dd>\${req.method}</dd>
              <dt>URL</dt><dd>\${req.url}</dd>
              <dt>Request ID</dt><dd>\${req.id}</dd>
              \${req.headers && Object.entries(req.headers).map(([k,v]) => html\`<dt>\${escapeHtml(k)}</dt><dd>\${escapeHtml(v)}</dd>\`)}
            </dl>\`}
          </div>\`}

          <div class="section">
            <h3 onClick=\${() => toggle('meta')}>\${collapsed.meta ? '\\u25b6' : '\\u25bc'} Process Metadata</h3>
            \${!collapsed.meta && html\`<dl class="kv-grid">
              <dt>Node</dt><dd>\${meta.nodeVersion}</dd>
              <dt>Platform</dt><dd>\${meta.platform} \${meta.arch}</dd>
              <dt>PID</dt><dd>\${meta.pid}</dd>
              <dt>Hostname</dt><dd>\${meta.hostname}</dd>
              <dt>Memory (RSS)</dt><dd>\${meta.memoryUsage ? Math.round(meta.memoryUsage.rss/1048576) + ' MB' : ''}</dd>
              <dt>Heap Used</dt><dd>\${meta.memoryUsage ? Math.round(meta.memoryUsage.heapUsed/1048576) + ' MB' : ''}</dd>
              <dt>Event Loop Lag</dt><dd>\${typeof meta.eventLoopLagMs === 'number' ? meta.eventLoopLagMs.toFixed(1) + ' ms' : ''}</dd>
              <dt>Uptime</dt><dd>\${meta.uptime ? Math.round(meta.uptime) + ' s' : ''}</dd>
            </dl>\`}
          </div>

          \${Object.keys(env).length > 0 && html\`<div class="section">
            <h3 onClick=\${() => toggle('env')}>\${collapsed.env ? '\\u25b6' : '\\u25bc'} Environment</h3>
            \${!collapsed.env && html\`<dl class="kv-grid">
              \${Object.entries(env).map(([k,v]) => html\`<dt>\${escapeHtml(k)}</dt><dd>\${escapeHtml(v)}</dd>\`)}
            </dl>\`}
          </div>\`}

          <div class="section">
            <h3 onClick=\${() => toggle('comp')}>\${collapsed.comp ? '\\u25b6' : '\\u25bc'} Completeness</h3>
            \${!collapsed.comp && html\`<dl class="kv-grid">
              \${Object.entries(comp).map(([k,v]) => html\`<dt>\${k}</dt><dd>\${Array.isArray(v) ? v.join(', ') || 'none' : String(v)}</dd>\`)}
            </dl>\`}
          </div>

          <div class="section">
            <h3 onClick=\${() => setShowRaw(!showRaw)}>\${showRaw ? '\\u25bc' : '\\u25b6'} Raw JSON</h3>
            \${showRaw && html\`<div class="raw-json">\${escapeHtml(JSON.stringify(pkg, null, 2))}</div>\`}
          </div>
        </div>\`;
    }

    /* ---- Stats view ---- */
    function StatsView({ stats }) {
      if (!stats) return html\`<div class="empty-state"><p>Loading...</p></div>\`;
      const hours = Object.entries(stats.byHour).sort(([a],[b]) => a.localeCompare(b));
      const maxCount = Math.max(...hours.map(([,c]) => c), 1);

      return html\`
        <div class="stats-grid">
          <div class="stat-card">
            <h3>Total Errors</h3>
            <div class="stat-number">\${stats.total}</div>
          </div>
          <div class="stat-card">
            <h3>By Type</h3>
            <ul class="stat-list">
              \${Object.entries(stats.byType).sort(([,a],[,b]) => b-a).map(([type, count]) => html\`
                <li><span class="type-badge \${typeClass(type)}"><span class="severity-dot" style="background:\${severityColor(type)}"></span>\${escapeHtml(type)}</span> <span class="stat-count">\${count}</span></li>
              \`)}
            </ul>
          </div>
          <div class="stat-card">
            <h3>Top Errors</h3>
            <ul class="stat-list">
              \${stats.topErrors.map(e => html\`
                <li><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">\${escapeHtml(e.message)}</span> <span class="stat-count">\${e.count}</span></li>
              \`)}
            </ul>
          </div>
          <div class="stat-card" style="grid-column: 1 / -1">
            <h3>Errors Over Time</h3>
            \${hours.length === 0 ? html\`<p style="color:var(--text-secondary)">No data yet</p>\`
            : html\`<div class="chart-bar">
              \${hours.map(([hour, count]) => html\`
                <div class="chart-col" style="height:\${Math.max(4, (count/maxCount)*100)}%" title="\${hour}: \${count}"></div>
              \`)}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;font-family:var(--font-mono);color:var(--text-secondary);margin-top:6px;opacity:0.7">
              <span>\${hours[0]?.[0] || ''}</span><span>\${hours[hours.length-1]?.[0] || ''}</span>
            </div>\`}
          </div>
        </div>\`;
    }

    render(html\`<\${App} />\`, document.getElementById('app'));
  </script>
</body>
</html>`;
}
