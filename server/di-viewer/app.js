// Postgres Viewer — frontend.
// Vanilla JS. Talks to the local server (/api/*), which proxies to the pg-proxy.

const ROW_H = 28;
const HEAD_H = 30;
const OVERSCAN = 6;
const GUTTER_W = 52;
const DEFAULT_PAGE = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUM_RE = /^-?\d+(\.\d+)?$/;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  config: null,
  tables: [],
  filterText: '',
  mode: 'idle',           // 'idle' | 'table' | 'sql'
  activeTable: null,      // { schema, name }
  columns: [],            // [{ name, kind, pgType, width }]
  rows: [],               // rows for the CURRENT PAGE (objects)
  allRows: [],            // SQL mode: full result set
  total: 0,
  page: 0,
  pageSize: DEFAULT_PAGE,
  sort: null,             // { col, dir: 'asc'|'desc' }
  pk: [],
  selection: null,        // { r, c } into state.rows
  loading: false,
};

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', 'toast'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, opts = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(path, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Request timed out (server unreachable?)');
    throw new Error('Network error: ' + (e?.message || e) + ' — is the server running?');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await resp.json(); } catch { data = { error: `HTTP ${resp.status}` }; }
  if (resp.status === 401) { window.location.href = '/admin'; }
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  if (data && data.error && !Array.isArray(data.rows)) throw new Error(data.error);
  return data;
}
async function runSql(sql, params = []) {
  return api('/db-viewer/api/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
}

// SQL identifier / literal quoting (identifiers come from information_schema or known columns)
const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const ql = (val) => "'" + String(val).replace(/'/g, "''") + "'";

// ---------------------------------------------------------------------------
// Type handling
// ---------------------------------------------------------------------------
function pgTypeToKind(dataType, udt) {
  const t = (dataType || '').toLowerCase();
  const u = (udt || '').toLowerCase();
  if (u.startsWith('_')) return 'json';                     // arrays
  if (t.includes('int') || t.includes('numeric') || t.includes('decimal') ||
      t.includes('real') || t.includes('double') || t.includes('float') || t === 'money') return 'num';
  if (t.includes('bool')) return 'bool';
  if (t.includes('timestamp') || t.includes('date') || t.includes('time')) return 'time';
  if (t === 'uuid') return 'uuid';
  if (t.includes('json')) return 'json';
  return 'text';
}

function inferKind(values) {
  const sample = values.filter((v) => v !== null && v !== undefined).slice(0, 120);
  if (!sample.length) return 'text';
  const kinds = new Set();
  for (const v of sample) {
    if (typeof v === 'boolean') kinds.add('bool');
    else if (typeof v === 'number') kinds.add('num');
    else if (typeof v === 'object') kinds.add('json');
    else if (typeof v === 'string') {
      if (UUID_RE.test(v)) kinds.add('uuid');
      else if (ISO_RE.test(v)) kinds.add('time');
      else if (NUM_RE.test(v)) kinds.add('num');
      else if (/^[[{]/.test(v.trim())) kinds.add('json');
      else kinds.add('text');
    } else kinds.add('text');
  }
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.has('text')) return 'text';
  if (kinds.size === 2 && kinds.has('num') && kinds.has('time')) return 'text';
  return 'text';
}

function tryParseJson(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[[{]/.test(s)) { try { return JSON.parse(s); } catch { return null; } }
  }
  return null;
}

function formatTime(v, pgType) {
  const s = String(v);
  const isDate = pgType === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return { text: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }), title: s };
    }
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) return { text: s, title: s };
  const text = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return { text, title: s };
}

// Returns { html (already-escaped markup), raw (string for copy/formula), title }
function renderValue(value, kind, pgType) {
  if (value === null || value === undefined) {
    return { html: '<span class="cv">NULL</span>', raw: '', title: 'NULL', cls: 't-null' };
  }
  switch (kind) {
    case 'bool': {
      const b = value === true || value === 'true' || value === 't' || value === 1 || value === '1';
      const html = `<span class="bool-pill ${b ? 'true' : 'false'}">${b ? '✓ true' : '✗ false'}</span>`;
      return { html, raw: b ? 'true' : 'false', title: b ? 'true' : 'false', cls: 't-bool' };
    }
    case 'num': {
      const s = String(value);
      return { html: `<span class="cv">${escapeHtml(s)}</span>`, raw: s, title: s, cls: 't-num' };
    }
    case 'time': {
      const f = formatTime(value, pgType);
      return { html: `<span class="cv">${escapeHtml(f.text)}</span>`, raw: String(value), title: f.title, cls: 't-time' };
    }
    case 'uuid': {
      const s = String(value);
      return { html: `<span class="cv">${escapeHtml(s)}</span>`, raw: s, title: s, cls: 't-uuid' };
    }
    case 'json': {
      const parsed = tryParseJson(value);
      if (parsed === null) {
        const s = String(value);
        return { html: `<span class="cv">${escapeHtml(s)}</span>`, raw: s, title: s, cls: 't-text' };
      }
      const isArr = Array.isArray(parsed);
      const compact = JSON.stringify(parsed);
      const n = isArr ? parsed.length : Object.keys(parsed).length;
      const preview = compact.length > 60 ? compact.slice(0, 60) + '…' : compact;
      const html = `<span class="json-chip"><span class="jb">${isArr ? `[${n}]` : `{${n}}`}</span><span class="jp">${escapeHtml(preview)}</span></span>`;
      return { html, raw: compact, title: `${isArr ? 'array' : 'object'} · ${n} ${isArr ? 'items' : 'keys'} · double-click to expand`, cls: 't-json', json: parsed };
    }
    default: {
      const s = String(value);
      const long = s.length > 40 || s.includes('\n');
      return { html: `<span class="cv${long ? ' long' : ''}">${escapeHtml(s)}</span>`, raw: s, title: s, cls: 't-text' };
    }
  }
}

function colLetter(idx) {
  let s = '', n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function defaultWidth(kind, name) {
  const base = Math.min(360, Math.max(90, (name.length + 2) * 8));
  switch (kind) {
    case 'json': return Math.max(base, 220);
    case 'time': return Math.max(base, 168);
    case 'uuid': return Math.max(base, 150);
    case 'num': return Math.max(base, 96);
    case 'bool': return Math.max(base, 96);
    default: return base;
  }
}

// ---------------------------------------------------------------------------
// Data loading — table mode
// ---------------------------------------------------------------------------
async function loadTableList() {
  const r = await runSql(
    `select table_schema, table_name from information_schema.tables
     where table_schema = 'di' and table_type = 'BASE TABLE'
     order by table_schema, table_name`
  );
  state.tables = (r.rows || []).map((x) => ({ schema: x.table_schema, name: x.table_name }));
  renderTableList();
}

async function loadTable(schema, name, { keepPage = false } = {}) {
  state.mode = 'table';
  state.activeTable = { schema, name };
  state.selection = null;
  if (!keepPage) state.page = 0;
  markActiveTable();
  setLoading(true);
  hideError();
  try {
    const ident = `${qi(schema)}.${qi(name)}`;
    const [colsRes, pkRes] = await Promise.all([
      runSql(
        `select column_name, data_type, udt_name from information_schema.columns
         where table_schema = ${ql(schema)} and table_name = ${ql(name)}
         order by ordinal_position`
      ),
      runSql(
        `select kcu.column_name from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_schema = kcu.table_schema
          and tc.table_name = kcu.table_name
         where tc.constraint_type = 'PRIMARY KEY'
           and tc.table_schema = ${ql(schema)} and tc.table_name = ${ql(name)}
         order by kcu.ordinal_position`
      ),
    ]);

    const cols = (colsRes.rows || []).map((c) => {
      const kind = pgTypeToKind(c.data_type, c.udt_name);
      return { name: c.column_name, kind, pgType: c.udt_name || c.data_type, width: defaultWidth(kind, c.column_name) };
    });
    // preserve any user-set widths for the same table across reloads
    if (state.activeTable && state._lastTable === `${schema}.${name}` && state.columns.length) {
      const prev = new Map(state.columns.map((c) => [c.name, c.width]));
      cols.forEach((c) => { if (prev.has(c.name)) c.width = prev.get(c.name); });
    }
    state._lastTable = `${schema}.${name}`;
    state.columns = cols;
    state.pk = (pkRes.rows || []).map((r) => r.column_name);

    const [pageRows, total] = await Promise.all([ fetchTablePage(), fetchCount(ident) ]);
    state.rows = pageRows;
    state.total = total;
    state.allRows = [];
    render();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function orderByClause() {
  if (state.sort) return `${qi(state.sort.col)} ${state.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
  if (state.pk && state.pk.length) return state.pk.map(qi).join(', ');
  if (state.columns.length) return qi(state.columns[0].name);
  return '1';
}

async function fetchTablePage() {
  const { schema, name } = state.activeTable;
  const ident = `${qi(schema)}.${qi(name)}`;
  const offset = state.page * state.pageSize;
  const r = await runSql(
    `select * from ${ident} order by ${orderByClause()} limit ${state.pageSize} offset ${offset}`
  );
  return r.rows || [];
}

async function fetchCount(ident) {
  try {
    const r = await runSql(`select count(*)::bigint as n from ${ident}`);
    return Number(r.rows?.[0]?.n ?? 0);
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Data loading — SQL mode
// ---------------------------------------------------------------------------
async function runUserSql() {
  const sql = $('sql-input').value.trim();
  if (!sql) { $('sql-status').textContent = 'Enter a query first.'; return; }
  state.mode = 'sql';
  state.activeTable = null;
  state.selection = null;
  state.page = 0;
  markActiveTable();
  setLoading(true); hideError();
  $('sql-status').className = 'sql-status';
  $('sql-status').textContent = 'Running…';
  const t0 = performance.now();
  try {
    const r = await runSql(sql);
    const ms = Math.round(performance.now() - t0);
    const rows = r.rows || [];
    if (r.truncated) toast('Result limited to 1,000 rows. Add filters to narrow your query.');
    const colNames = rows.length ? Object.keys(rows[0]) : [];
    state.columns = colNames.map((name) => {
      const kind = inferKind(rows.map((x) => x[name]));
      return { name, kind, pgType: kind, width: defaultWidth(kind, name) };
    });
    state.allRows = rows;
    state.total = rows.length;
    state.rows = rows.slice(0, state.pageSize);
    state.pk = [];
    $('sql-status').textContent = `${r.command || 'OK'} · ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} · ${ms} ms`;
    render();
    if (!rows.length) showEmpty('Query returned 0 rows', 'The statement ran successfully but produced no rows.');
  } catch (err) {
    $('sql-status').className = 'sql-status err';
    $('sql-status').textContent = err.message;
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function applySqlPaging() {
  let rows = state.allRows;
  if (state.sort) {
    const { col, dir } = state.sort;
    const sign = dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => cmp(a[col], b[col]) * sign);
  }
  state.total = rows.length;
  const start = state.page * state.pageSize;
  state.rows = rows.slice(start, start + state.pageSize);
}
function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && typeof a !== 'object' && typeof b !== 'object') return na < nb ? -1 : na > nb ? 1 : 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  buildSkeleton();
  renderBody();
  renderToolbar();
  renderFormulaBar();
  if (state.rows.length === 0 && state.mode === 'table') {
    showEmpty('This table is empty', 'No rows to display.');
  } else if (state.rows.length === 0 && state.mode === 'idle') {
    showEmpty('Nothing to show', 'Pick a table on the left, or run a SQL query.');
  } else {
    hideEmpty();
  }
}

function buildSkeleton() {
  const grid = $('grid');
  grid.innerHTML = '';
  if (!state.columns.length) return;

  const colgroup = el('colgroup');
  colgroup.appendChild(el('col')).style.width = GUTTER_W + 'px';
  state.columns.forEach((c) => {
    const col = el('col');
    col.style.width = c.width + 'px';
    colgroup.appendChild(col);
  });
  grid.appendChild(colgroup);

  const thead = el('thead');
  const htr = el('tr');
  const gh = el('th', 'gutter', '');
  htr.appendChild(gh);
  state.columns.forEach((c, i) => {
    const th = el('th', 'sortable');
    th.dataset.c = String(i);
    th.style.width = c.width + 'px';
    const inner = el('div', 'th-inner');
    inner.appendChild(el('span', 'th-name', c.name));
    if (c.pgType && c.pgType !== c.kind) inner.appendChild(el('span', 'th-type', c.pgType));
    const sortSpan = el('span', 'th-sort');
    if (state.sort && state.sort.col === c.name) {
      sortSpan.textContent = state.sort.dir === 'asc' ? '▲' : '▼';
      th.classList.add('col-active');
    }
    inner.appendChild(sortSpan);
    th.appendChild(inner);
    const rz = el('div', 'resizer');
    rz.dataset.c = String(i);
    th.appendChild(rz);
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  grid.appendChild(thead);
  grid.appendChild(el('tbody'));
}

function renderBody() {
  const tbody = $('grid').querySelector('tbody');
  if (!tbody) return;
  const scroll = $('grid-scroll');
  const rows = state.rows;
  const colCount = state.columns.length;

  if (!rows.length) { tbody.innerHTML = ''; return; }

  const scrollTop = scroll.scrollTop;
  const viewH = scroll.clientHeight || 600;
  const bodyTop = Math.max(0, scrollTop - HEAD_H);
  let start = Math.floor(bodyTop / ROW_H) - OVERSCAN;
  let end = Math.ceil((bodyTop + viewH) / ROW_H) + OVERSCAN;
  start = Math.max(0, start);
  end = Math.min(rows.length, end);

  const baseIndex = state.page * state.pageSize;
  const parts = [];
  const topH = start * ROW_H;
  if (topH > 0) parts.push(`<tr class="spacer"><td colspan="${colCount + 1}" style="height:${topH}px;padding:0;border:0"></td></tr>`);

  for (let r = start; r < end; r++) {
    const row = rows[r];
    const rowNum = baseIndex + r + 1;
    const rowActive = state.selection && state.selection.r === r ? ' row-active' : '';
    let html = `<tr data-r="${r}"><td class="gutter${rowActive}">${rowNum}</td>`;
    for (let c = 0; c < colCount; c++) {
      const col = state.columns[c];
      const v = row[col.name];
      const rv = renderValue(v, col.kind, col.pgType);
      const sel = state.selection && state.selection.r === r && state.selection.c === c ? ' selected' : '';
      html += `<td class="cell ${rv.cls}${sel}" data-r="${r}" data-c="${c}" title="${escapeHtml(rv.title || '')}">${rv.html}</td>`;
    }
    html += '</tr>';
    parts.push(html);
  }

  const botH = (rows.length - end) * ROW_H;
  if (botH > 0) parts.push(`<tr class="spacer"><td colspan="${colCount + 1}" style="height:${botH}px;padding:0;border:0"></td></tr>`);

  tbody.innerHTML = parts.join('');
}

function renderToolbar() {
  const titleEl = $('table-title');
  const badge = $('sql-badge');
  const rc = $('row-count');
  if (state.mode === 'table' && state.activeTable) {
    titleEl.textContent = state.activeTable.name;
    titleEl.title = `${state.activeTable.schema}.${state.activeTable.name}`;
    badge.classList.add('hidden');
    rc.textContent = state.total ? `${state.total.toLocaleString()} rows` : '';
    if (state.pk?.length) rc.textContent += ` · PK: ${state.pk.join(', ')}`;
  } else if (state.mode === 'sql') {
    titleEl.textContent = 'Query result';
    badge.classList.remove('hidden');
    rc.textContent = `${state.total.toLocaleString()} rows`;
  } else {
    titleEl.textContent = 'Select a table to browse';
    titleEl.title = '';
    badge.classList.add('hidden');
    rc.textContent = '';
  }
  renderPager();
}

function renderPager() {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const start = state.total === 0 ? 0 : state.page * state.pageSize + 1;
  const end = Math.min(state.total, (state.page + 1) * state.pageSize);
  $('page-info').textContent = state.total ? `${start.toLocaleString()}–${end.toLocaleString()} of ${state.total.toLocaleString()}` : '—';
  $('first-page').disabled = $('prev-page').disabled = state.page <= 0;
  $('next-page').disabled = $('last-page').disabled = state.page >= totalPages - 1;
}

function renderFormulaBar() {
  const refEl = $('cell-ref');
  const valEl = $('formula-value');
  if (!state.selection || !state.rows.length) {
    refEl.innerHTML = '&nbsp;';
    valEl.textContent = '';
    valEl.title = '';
    return;
  }
  const { r, c } = state.selection;
  const row = state.rows[r];
  const col = state.columns[c];
  if (!row || !col) return;
  const rv = renderValue(row[col.name], col.kind, col.pgType);
  refEl.textContent = `${colLetter(c)}${state.page * state.pageSize + r + 1}`;
  valEl.textContent = rv.raw || (rv.cls === 't-null' ? 'NULL' : '');
  valEl.title = `${col.name} — ${rv.raw || 'NULL'}`;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------
function setLoading(on) {
  state.loading = on;
  $('grid-loading').classList.toggle('hidden', !on);
}
function showEmpty(title, sub) {
  $('empty-title').textContent = title;
  $('empty-sub').textContent = sub || '';
  $('grid-empty').classList.remove('hidden');
  $('grid-error').classList.add('hidden');
}
function hideEmpty() {
  $('grid-empty').classList.add('hidden');
  $('grid-error').classList.add('hidden');
}
function showError(msg) {
  $('error-msg').textContent = msg;
  $('grid-error').classList.remove('hidden');
  $('grid-empty').classList.add('hidden');
  $('grid').innerHTML = '';
}
function hideError() {
  $('grid-error').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Table list (sidebar)
// ---------------------------------------------------------------------------
function renderTableList() {
  const list = $('table-list');
  const q = state.filterText.trim().toLowerCase();
  const items = state.tables.filter((t) => !q || t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q));
  list.innerHTML = '';
  $('table-count').textContent = `${items.length}${q ? ' / ' + state.tables.length : ''} tables`;
  if (!items.length) {
    const li = el('li', 'empty', q ? 'No tables match your search.' : 'No tables found.');
    list.appendChild(li);
    return;
  }
  const multiSchema = new Set(state.tables.map((t) => t.schema)).size > 1;
  items.forEach((t) => {
    const li = el('li');
    li.dataset.schema = t.schema;
    li.dataset.name = t.name;
    li.appendChild(el('span', 't-ico', '▦'));
    li.appendChild(el('span', 't-name', t.name));
    if (multiSchema) li.appendChild(el('span', 't-schema', t.schema));
    if (state.activeTable && state.activeTable.name === t.name && state.activeTable.schema === t.schema) li.classList.add('active');
    li.addEventListener('click', () => loadTable(t.schema, t.name));
    list.appendChild(li);
  });
}
function markActiveTable() {
  document.querySelectorAll('#table-list li').forEach((li) => {
    const on = state.activeTable && li.dataset.name === state.activeTable.name && li.dataset.schema === state.activeTable.schema && state.mode === 'table';
    li.classList.toggle('active', !!on);
  });
}

// ---------------------------------------------------------------------------
// Selection & modal
// ---------------------------------------------------------------------------
function selectCell(r, c, { scroll = false } = {}) {
  if (r < 0 || c < 0 || r >= state.rows.length || c >= state.columns.length) return;
  state.selection = { r, c };
  document.querySelectorAll('.grid td.cell.selected').forEach((n) => n.classList.remove('selected'));
  document.querySelectorAll('.grid td.gutter.row-active').forEach((n) => n.classList.remove('row-active'));
  document.querySelectorAll('.grid thead th.col-active').forEach((n) => {
    if (!state.sort || state.sort.col !== state.columns[c]?.name) n.classList.remove('col-active');
  });
  const td = document.querySelector(`.grid td.cell[data-r="${r}"][data-c="${c}"]`);
  if (td) {
    td.classList.add('selected');
    const tr = td.parentElement;
    const g = tr?.querySelector('td.gutter');
    if (g) g.classList.add('row-active');
    if (scroll) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  renderFormulaBar();
}

function openModalForSelection() {
  if (!state.selection) return;
  const { r, c } = state.selection;
  const col = state.columns[c];
  const value = state.rows[r]?.[col.name];
  openValueModal(col, value);
}

function openValueModal(col, value) {
  const rv = renderValue(value, col.kind, col.pgType);
  $('modal-title').textContent = col.name;
  const body = $('modal-body');
  if (rv.json !== undefined) {
    body.innerHTML = `<pre>${highlightJson(rv.json)}</pre>`;
    $('modal-meta').textContent = `${Array.isArray(rv.json) ? 'array' : 'object'} · ${rv.raw.length.toLocaleString()} chars`;
    body.dataset.copy = rv.raw;
  } else {
    const isNull = value === null || value === undefined;
    body.innerHTML = `<div class="plain">${isNull ? '<em style="color:var(--null)">NULL</em>' : escapeHtml(String(value))}</div>`;
    $('modal-meta').textContent = `${col.pgType || col.kind} · ${isNull ? 'NULL' : String(value).length.toLocaleString() + ' chars'}`;
    body.dataset.copy = isNull ? '' : String(value);
  }
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }

function highlightJson(obj) {
  // Escape only &, <, > so the JSON's structural double-quotes stay literal for the
  // tokenizer regex below (escaping them to &quot; would break all matching).
  const json = JSON.stringify(obj, null, 2)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (m) => {
      let cls = 'j-num';
      if (m[0] === '"') cls = /:$/.test(m) ? 'j-key' : 'j-str';
      else if (m === 'true' || m === 'false') cls = 'j-bool';
      else if (m === 'null') cls = 'j-null';
      return `<span class="${cls}">${m}</span>`;
    }
  );
}

async function copySelection() {
  const val = $('formula-value').textContent;
  if (!val) return;
  try { await navigator.clipboard.writeText(val); toast('Copied to clipboard'); }
  catch { toast('Copy failed'); }
}

// ---------------------------------------------------------------------------
// Sorting & paging actions
// ---------------------------------------------------------------------------
function toggleSort(colName) {
  const cur = state.sort && state.sort.col === colName ? state.sort.dir : null;
  const next = cur === null ? 'asc' : cur === 'asc' ? 'desc' : null;
  state.sort = next ? { col: colName, dir: next } : null;
  state.page = 0;
  if (state.mode === 'table') {
    if (state.activeTable) {
      setLoading(true); hideError();
      fetchTablePage().then((rows) => { state.rows = rows; render(); })
        .catch((e) => showError(e.message)).finally(() => setLoading(false));
    }
  } else if (state.mode === 'sql') {
    applySqlPaging(); render();
  }
}

function gotoPage(p) {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const np = Math.max(0, Math.min(totalPages - 1, p));
  if (np === state.page) return;
  state.page = np;
  state.selection = null;
  if (state.mode === 'table') {
    setLoading(true); hideError();
    fetchTablePage().then((rows) => { state.rows = rows; $('grid-scroll').scrollTop = 0; render(); })
      .catch((e) => showError(e.message)).finally(() => setLoading(false));
  } else {
    applySqlPaging(); $('grid-scroll').scrollTop = 0; render();
  }
}

// ---------------------------------------------------------------------------
// Connection / config
// ---------------------------------------------------------------------------
async function loadConfig() {
  try {
    state.config = await api('/db-viewer/api/config');
    $('db-badge').textContent = state.config.dbName || '—';
    $('access-badge').textContent = state.config.access || 'read-only';
    updateExpiry();
    setInterval(updateExpiry, 60000);
  } catch (e) {
    $('db-badge').textContent = 'config error';
  }
}
function updateExpiry() {
  const ex = state.config?.expiresAt;
  const node = $('expiry');
  if (!ex) { node.textContent = ''; return; }
  const ms = new Date(ex).getTime() - Date.now();
  node.classList.remove('warn', 'expired');
  if (ms <= 0) { node.textContent = 'token expired'; node.classList.add('expired'); return; }
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
  node.textContent = d > 0 ? `expires in ${d}d ${h}h` : `expires in ${h}h`;
  if (ms < 86400000) node.classList.add('warn');
  node.title = `Token expires ${new Date(ex).toLocaleString()}`;
}
async function checkHealth() {
  const dot = $('conn-dot');
  try {
    await api('/db-viewer/api/health');
    dot.className = 'dot ok'; dot.title = 'Connected';
  } catch {
    dot.className = 'dot err'; dot.title = 'Cannot reach database';
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  // sidebar search
  $('table-search').addEventListener('input', (e) => { state.filterText = e.target.value; renderTableList(); });

  // grid: click / double-click / keyboard via delegation
  const scroll = $('grid-scroll');
  scroll.addEventListener('click', (e) => {
    const th = e.target.closest('thead th.sortable');
    if (th && !e.target.classList.contains('resizer')) {
      const c = Number(th.dataset.c);
      toggleSort(state.columns[c].name);
      return;
    }
    const td = e.target.closest('td.cell');
    if (td) selectCell(Number(td.dataset.r), Number(td.dataset.c));
  });
  scroll.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td.cell');
    if (td) { selectCell(Number(td.dataset.r), Number(td.dataset.c)); openModalForSelection(); }
  });

  // column resize
  let resizing = null;
  scroll.addEventListener('mousedown', (e) => {
    const rz = e.target.closest('.resizer');
    if (!rz) return;
    e.preventDefault();
    const c = Number(rz.dataset.c);
    const th = rz.parentElement;
    resizing = { c, startX: e.clientX, startW: th.getBoundingClientRect().width, rz };
    rz.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const w = Math.max(60, Math.round(resizing.startW + (e.clientX - resizing.startX)));
    state.columns[resizing.c].width = w;
    const col = $('grid').querySelectorAll('colgroup col')[resizing.c + 1];
    if (col) col.style.width = w + 'px';
    const th = $('grid').querySelectorAll('thead th')[resizing.c + 1];
    if (th) th.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (resizing) { resizing.rz.classList.remove('dragging'); document.body.style.cursor = ''; resizing = null; }
  });

  // virtualized scroll
  let raf = null;
  scroll.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; renderBody(); });
  });

  // keyboard navigation
  window.addEventListener('keydown', (e) => {
    if (!$('modal').classList.contains('hidden')) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !typing) { copySelection(); return; }
    if (typing) return;
    if (!state.selection || !state.rows.length) return;
    const { r, c } = state.selection;
    let nr = r, nc = c, handled = true;
    switch (e.key) {
      case 'ArrowUp': nr = Math.max(0, r - 1); break;
      case 'ArrowDown': nr = Math.min(state.rows.length - 1, r + 1); break;
      case 'ArrowLeft': nc = Math.max(0, c - 1); break;
      case 'ArrowRight': nc = Math.min(state.columns.length - 1, c + 1); break;
      case 'Enter': openModalForSelection(); return;
      case 'Escape': state.selection = null; renderBody(); renderFormulaBar(); return;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); selectCell(nr, nc, { scroll: true }); }
  });

  // toolbar / paging
  $('page-size').addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value); state.page = 0; state.selection = null;
    if (state.mode === 'table' && state.activeTable) {
      setLoading(true); hideError();
      fetchTablePage().then((rows) => { state.rows = rows; render(); }).catch((er) => showError(er.message)).finally(() => setLoading(false));
    } else if (state.mode === 'sql') { applySqlPaging(); render(); }
  });
  $('first-page').addEventListener('click', () => gotoPage(0));
  $('prev-page').addEventListener('click', () => gotoPage(state.page - 1));
  $('next-page').addEventListener('click', () => gotoPage(state.page + 1));
  $('last-page').addEventListener('click', () => gotoPage(Math.ceil(state.total / state.pageSize) - 1));

  // formula bar buttons
  $('btn-copy').addEventListener('click', copySelection);
  $('btn-expand').addEventListener('click', openModalForSelection);

  // SQL panel
  $('btn-sql').addEventListener('click', () => {
    const p = $('sql-panel');
    p.classList.toggle('hidden');
    $('btn-sql').classList.toggle('active', !p.classList.contains('hidden'));
    if (!p.classList.contains('hidden')) $('sql-input').focus();
  });
  $('btn-run-sql').addEventListener('click', runUserSql);
  $('btn-clear-sql').addEventListener('click', () => { $('sql-input').value = ''; $('sql-status').textContent = ''; });
  $('sql-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runUserSql(); }
  });

  // refresh
  $('btn-refresh').addEventListener('click', async () => {
    checkHealth();
    try { await loadTableList(); toast('Table list refreshed'); } catch (e) { toast('Refresh failed: ' + e.message); }
  });

  // modal
  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('modal-copy').addEventListener('click', async () => {
    const txt = $('modal-body').dataset.copy || '';
    try { await navigator.clipboard.writeText(txt); toast('Copied to clipboard'); } catch { toast('Copy failed'); }
  });

  window.addEventListener('resize', () => renderBody());
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  wireEvents();
  $('page-size').value = String(state.pageSize);
  await loadConfig();
  checkHealth();
  render();
  showEmpty('Nothing to show', 'Pick a table on the left, or run a SQL query.');
  try {
    await loadTableList();
  } catch (e) {
    $('table-count').textContent = 'failed to load tables';
    showError('Could not load tables: ' + e.message);
  }
}

init();
