
export function renderHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ErrorCore Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0d1117; --bg-secondary: #161b22; --bg-tertiary: #21262d;
      --border: #30363d; --text: #c9d1d9; --text-dim: #8b949e;
      --text-bright: #f0f6fc; --accent: #58a6ff; --red: #f85149;
      --yellow: #d29922; --green: #3fb950; --purple: #bc8cff;
      --orange: #d18616; --font-mono: 'SF Mono', 'Fira Code', monospace;
      --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font-ui); font-size: 14px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .header { background: var(--bg-secondary); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 16px; color: var(--text-bright); font-weight: 600; }
    .header nav { display: flex; gap: 16px; }
    .header nav a { color: var(--text-dim); font-size: 13px; cursor: pointer; }
    .header nav a.active { color: var(--accent); }

    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

    .search-bar { display: flex; gap: 8px; margin-bottom: 16px; }
    .search-bar input { flex: 1; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: var(--text); font-size: 13px; outline: none; }
    .search-bar input:focus { border-color: var(--accent); }
    .search-bar select { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text); font-size: 13px; }

    .table { width: 100%; border-collapse: collapse; }
    .table th { text-align: left; padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
    .table td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
    .table tr:hover { background: var(--bg-secondary); cursor: pointer; }
    .table .type-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; font-family: var(--font-mono); }
    .type-Error { background: rgba(248,81,73,0.15); color: var(--red); }
    .type-TypeError { background: rgba(210,153,34,0.15); color: var(--yellow); }
    .type-RangeError { background: rgba(188,140,255,0.15); color: var(--purple); }
    .type-default { background: rgba(88,166,255,0.15); color: var(--accent); }
    .msg-truncate { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .timestamp { color: var(--text-dim); font-family: var(--font-mono); font-size: 12px; }

    .pagination { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; color: var(--text-dim); font-size: 13px; }
    .pagination button { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; color: var(--text); cursor: pointer; font-size: 13px; }
    .pagination button:disabled { opacity: 0.4; cursor: default; }
    .pagination button:hover:not(:disabled) { border-color: var(--accent); }

    .detail { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 16px; }
    .detail-header { padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .detail-header h2 { font-size: 18px; color: var(--text-bright); margin-bottom: 4px; }
    .detail-header .meta { color: var(--text-dim); font-size: 12px; }

    .section { padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .section:last-child { border-bottom: none; }
    .section h3 { font-size: 13px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; cursor: pointer; user-select: none; }
    .section h3:hover { color: var(--text); }

    .stack { background: var(--bg); border-radius: 6px; padding: 12px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; overflow-x: auto; white-space: pre; color: var(--text-dim); }
    .stack .frame-app { color: var(--text-bright); }

    .io-item { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--bg); font-size: 13px; }
    .io-item:last-child { border-bottom: none; }
    .method-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: var(--font-mono); min-width: 48px; text-align: center; }
    .method-GET { background: rgba(63,185,80,0.15); color: var(--green); }
    .method-POST { background: rgba(88,166,255,0.15); color: var(--accent); }
    .method-PUT { background: rgba(210,153,34,0.15); color: var(--yellow); }
    .method-DELETE { background: rgba(248,81,73,0.15); color: var(--red); }
    .method-query { background: rgba(188,140,255,0.15); color: var(--purple); }
    .method-default { background: rgba(139,148,158,0.15); color: var(--text-dim); }
    .status-chip { padding: 2px 6px; border-radius: 4px; font-size: 11px; font-family: var(--font-mono); }
    .status-2xx { background: rgba(63,185,80,0.15); color: var(--green); }
    .status-3xx { background: rgba(210,153,34,0.15); color: var(--yellow); }
    .status-4xx { background: rgba(248,81,73,0.15); color: var(--red); }
    .status-5xx { background: rgba(248,81,73,0.3); color: var(--red); }
    .duration-bar { height: 6px; background: var(--accent); border-radius: 3px; min-width: 2px; opacity: 0.7; }
    .io-target { color: var(--text-dim); font-family: var(--font-mono); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .io-duration { color: var(--text-dim); font-family: var(--font-mono); font-size: 12px; min-width: 60px; text-align: right; }

    .kv-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; font-size: 13px; }
    .kv-grid dt { color: var(--text-dim); font-family: var(--font-mono); }
    .kv-grid dd { color: var(--text); font-family: var(--font-mono); word-break: break-all; }

    .raw-json { background: var(--bg); border-radius: 6px; padding: 12px; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; overflow-x: auto; white-space: pre; max-height: 500px; overflow-y: auto; color: var(--text-dim); }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .stat-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; }
    .stat-card h3 { font-size: 13px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .stat-number { font-size: 36px; font-weight: 700; color: var(--text-bright); }
    .stat-list { list-style: none; }
    .stat-list li { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; border-bottom: 1px solid var(--bg); }
    .stat-list li:last-child { border-bottom: none; }
    .stat-count { font-family: var(--font-mono); color: var(--accent); }
    .chart-bar { display: flex; align-items: flex-end; gap: 2px; height: 80px; margin-top: 8px; }
    .chart-col { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; opacity: 0.7; position: relative; }
    .chart-col:hover { opacity: 1; }

    .empty-state { text-align: center; padding: 80px 20px; color: var(--text-dim); }
    .empty-state h2 { font-size: 20px; color: var(--text); margin-bottom: 8px; }

    .back-link { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 13px; margin-bottom: 16px; cursor: pointer; }
    .back-link:hover { color: var(--accent); }

    .btn-refresh { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; color: var(--text-dim); cursor: pointer; font-size: 12px; }
    .btn-refresh:hover { border-color: var(--accent); color: var(--accent); }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import { h, render, Component } from 'https://esm.sh/preact@10.25.4';
    import { useState, useEffect } from 'https://esm.sh/preact@10.25.4/hooks';
    import htm from 'https://esm.sh/htm@3.1.1';
    const html = htm.bind(h);

    function typeClass(t) {
      return ['Error','TypeError','RangeError'].includes(t) ? 'type-'+t : 'type-default';
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
      return d.toLocaleString();
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

    function App() {
      const [view, setView] = useState('list');
      const [errors, setErrors] = useState([]);
      const [total, setTotal] = useState(0);
      const [page, setPage] = useState(1);
      const [search, setSearch] = useState('');
      const [sort, setSort] = useState('newest');
      const [detail, setDetail] = useState(null);
      const [stats, setStats] = useState(null);
      const limit = 25;

      function fetchErrors() {
        const params = new URLSearchParams({ page, limit, sort });
        if (search) params.set('search', search);
        fetch('/api/errors?' + params).then(r => r.json()).then(data => {
          setErrors(data.entries); setTotal(data.total);
        });
      }
      function fetchStats() {
        fetch('/api/stats').then(r => r.json()).then(setStats);
      }
      function openDetail(id) {
        fetch('/api/errors/' + id).then(r => r.json()).then(data => {
          setDetail(data); setView('detail');
        });
      }

      useEffect(() => { if (view === 'list') fetchErrors(); }, [page, sort, view]);
      useEffect(() => { if (view === 'stats') fetchStats(); }, [view]);

      function doSearch(e) { e.preventDefault(); setPage(1); fetchErrors(); }

      if (view === 'detail' && detail) return html\`
        <\${Header} view=\${view} setView=\${setView} />
        <div class="container">
          <a class="back-link" onClick=\${() => setView('list')}>\u2190 Back to errors</a>
          <\${DetailView} pkg=\${detail} />
        </div>\`;

      if (view === 'stats') return html\`
        <\${Header} view=\${view} setView=\${setView} />
        <div class="container"><\${StatsView} stats=\${stats} /></div>\`;

      return html\`
        <\${Header} view=\${view} setView=\${setView} />
        <div class="container">
          <form class="search-bar" onSubmit=\${doSearch}>
            <input type="text" placeholder="Search errors..." value=\${search} onInput=\${e => setSearch(e.target.value)} />
            <select value=\${sort} onChange=\${e => { setSort(e.target.value); setPage(1); }}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
            <button class="btn-refresh" type="button" onClick=\${() => { fetch('/api/refresh', {method:'POST'}).then(fetchErrors); }}>\u21bb Refresh</button>
          </form>
          \${errors.length === 0 ? html\`
            <div class="empty-state">
              <h2>No errors captured yet</h2>
              <p>Errors will appear here once errorcore captures them.</p>
            </div>\`
          : html\`
            <table class="table">
              <thead><tr>
                <th>Time</th><th>Type</th><th>Message</th><th>URL</th>
              </tr></thead>
              <tbody>\${errors.map(e => html\`
                <tr key=\${e.id} onClick=\${() => openDetail(e.id)}>
                  <td class="timestamp">\${fmtTime(e.capturedAt)}</td>
                  <td><span class="type-badge \${typeClass(e.errorType)}">\${e.errorType}</span></td>
                  <td class="msg-truncate">\${e.errorMessage}</td>
                  <td class="msg-truncate" style="max-width:200px">\${e.url || '\u2014'}</td>
                </tr>
              \`)}</tbody>
            </table>
            <div class="pagination">
              <span>\${total} error\${total !== 1 ? 's' : ''} total</span>
              <div style="display:flex;gap:8px">
                <button disabled=\${page <= 1} onClick=\${() => setPage(p => p-1)}>\u2190 Prev</button>
                <span style="padding:6px">Page \${page} of \${Math.ceil(total/limit) || 1}</span>
                <button disabled=\${page >= Math.ceil(total/limit)} onClick=\${() => setPage(p => p+1)}>Next \u2192</button>
              </div>
            </div>
          \`}
        </div>\`;
    }

    function Header({ view, setView }) {
      return html\`<div class="header">
        <h1>ErrorCore</h1>
        <nav>
          <a class=\${view === 'list' ? 'active' : ''} onClick=\${() => setView('list')}>Errors</a>
          <a class=\${view === 'stats' ? 'active' : ''} onClick=\${() => setView('stats')}>Stats</a>
        </nav>
      </div>\`;
    }

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
            <h2><span class="type-badge \${typeClass(pkg.error?.type)}">\${pkg.error?.type}</span> \${pkg.error?.message}</h2>
            <div class="meta">\${fmtTime(pkg.capturedAt)}\${req ? ' \u2014 ' + req.method + ' ' + req.url : ''}</div>
          </div>

          <div class="section">
            <h3 onClick=\${() => toggle('stack')}>\${collapsed.stack ? '\u25b6' : '\u25bc'} Stack Trace</h3>
            \${!collapsed.stack && html\`<div class="stack">\${highlightStack(pkg.error?.stack)}</div>\`}
            \${!collapsed.stack && pkg.error?.rawStack && html\`
              <details style="margin-top:8px"><summary style="color:var(--text-dim);font-size:12px;cursor:pointer">Raw (unresolved) stack</summary>
              <div class="stack" style="margin-top:4px">\${pkg.error.rawStack}</div></details>\`}
          </div>

          \${io.length > 0 && html\`<div class="section">
            <h3 onClick=\${() => toggle('io')}>\${collapsed.io ? '\u25b6' : '\u25bc'} IO Timeline (\${io.length})</h3>
            \${!collapsed.io && io.map(ev => html\`
              <div class="io-item">
                <span class="method-badge \${ev.type === 'db-query' ? 'method-query' : methodClass(ev.method || '')}">\${ev.type === 'db-query' ? (ev.method || 'query') : (ev.method || ev.type)}</span>
                <span class="io-target">\${ev.url || ev.target}\${ev.dbMeta?.query ? ' \u2014 ' + ev.dbMeta.query : ''}</span>
                \${ev.statusCode ? html\`<span class="status-chip \${statusClass(ev.statusCode)}">\${ev.statusCode}</span>\` : ''}
                <span class="io-duration">\${fmtDuration(ev.durationMs)}</span>
                <div style="width:80px"><div class="duration-bar" style="width:\${Math.max(2, (ev.durationMs||0)/maxDur*80)}px"></div></div>
              </div>
            \`)}
          </div>\`}

          \${req && html\`<div class="section">
            <h3 onClick=\${() => toggle('req')}>\${collapsed.req ? '\u25b6' : '\u25bc'} Request Context</h3>
            \${!collapsed.req && html\`<dl class="kv-grid">
              <dt>Method</dt><dd>\${req.method}</dd>
              <dt>URL</dt><dd>\${req.url}</dd>
              <dt>Request ID</dt><dd>\${req.id}</dd>
              \${req.headers && Object.entries(req.headers).map(([k,v]) => html\`<dt>\${k}</dt><dd>\${v}</dd>\`)}
            </dl>\`}
          </div>\`}

          <div class="section">
            <h3 onClick=\${() => toggle('meta')}>\${collapsed.meta ? '\u25b6' : '\u25bc'} Process Metadata</h3>
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
            <h3 onClick=\${() => toggle('env')}>\${collapsed.env ? '\u25b6' : '\u25bc'} Environment</h3>
            \${!collapsed.env && html\`<dl class="kv-grid">
              \${Object.entries(env).map(([k,v]) => html\`<dt>\${k}</dt><dd>\${v}</dd>\`)}
            </dl>\`}
          </div>\`}

          <div class="section">
            <h3 onClick=\${() => toggle('comp')}>\${collapsed.comp ? '\u25b6' : '\u25bc'} Completeness</h3>
            \${!collapsed.comp && html\`<dl class="kv-grid">
              \${Object.entries(comp).map(([k,v]) => html\`<dt>\${k}</dt><dd>\${Array.isArray(v) ? v.join(', ') || 'none' : String(v)}</dd>\`)}
            </dl>\`}
          </div>

          <div class="section">
            <h3 onClick=\${() => setShowRaw(!showRaw)}>\${showRaw ? '\u25bc' : '\u25b6'} Raw JSON</h3>
            \${showRaw && html\`<div class="raw-json">\${JSON.stringify(pkg, null, 2)}</div>\`}
          </div>
        </div>\`;
    }

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
                <li><span class="type-badge \${typeClass(type)}">\${type}</span> <span class="stat-count">\${count}</span></li>
              \`)}
            </ul>
          </div>
          <div class="stat-card">
            <h3>Top Errors</h3>
            <ul class="stat-list">
              \${stats.topErrors.map(e => html\`
                <li><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">\${e.message}</span> <span class="stat-count">\${e.count}</span></li>
              \`)}
            </ul>
          </div>
          <div class="stat-card" style="grid-column: 1 / -1">
            <h3>Errors Over Time</h3>
            \${hours.length === 0 ? html\`<p style="color:var(--text-dim)">No data yet</p>\`
            : html\`<div class="chart-bar">
              \${hours.map(([hour, count]) => html\`
                <div class="chart-col" style="height:\${Math.max(4, (count/maxCount)*100)}%" title="\${hour}: \${count}"></div>
              \`)}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-top:4px">
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
