'use strict';

/** Full URL lists per output tab — used for output search / filter */
const lastOutputArrays = {
  'final-list': [],
  'with-scheme': [],
  'no-scheme': [],
  'ports-only': [],
  'skipped-list': [],
};

/* ══════════════════════════════════════════════
   PARSING — detect and extract raw URL strings
   ══════════════════════════════════════════════ */

function detectFormat(text) {
  const t = text.trim();
  if (t.startsWith('[')) return 'json';

  // Multi-line: check if any line looks like a CSV row (has quoted fields or commas)
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const csvLike = lines.some(l => (l.startsWith('"') && l.includes(',')) || l.split(',').length > 2);
    if (csvLike) return 'csv';
    return 'lines';
  }

  // Single line: if it has commas it's CSV
  if (t.includes(',')) return 'csv';
  return 'lines';
}

function parseInput(text, formatHint) {
  const format = formatHint === 'auto' ? detectFormat(text) : formatHint;

  if (format === 'json') {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to line-by-line
    }
  }

  if (format === 'csv') {
    // Parse each line as a CSV row and flatten — handles both single-line and multi-line CSVs
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
      if (line.includes(',') || line.startsWith('"')) {
        results.push(...parseCsvRow(line));
      } else {
        // Plain line with no commas — strip any surrounding quotes and add directly
        const v = line.replace(/^["']+|["']+$/g, '').trim();
        if (v) results.push(v);
      }
    }
    return results;
  }

  // default: one per line — strip surrounding quotes so "https://x.com" works
  return text.split('\n')
    .map(l => l.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter(Boolean);
}

function parseCsvRow(text) {
  const results = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      const v = current.trim();
      if (v) results.push(v);
      current = '';
    } else {
      current += ch;
    }
  }
  const v = current.trim();
  if (v) results.push(v);
  return results;
}

/* ══════════════════════════════════════════════
   SPLITTING — handle glued URLs (https://a...https://b)
   ══════════════════════════════════════════════ */

function splitGlued(value) {
  return value.split(/(?=https?:\/\/)/i).map(s => s.trim()).filter(Boolean);
}

/* ══════════════════════════════════════════════
   CLEANING — main URL normalisation
   ══════════════════════════════════════════════ */

const APP_TLDS = new Set(['controller', 'mpassplus', 'android', 'ios']);

/**
 * Returns { withScheme, noScheme, hasPort } or null if invalid.
 */
function cleanEntry(raw, opts) {
  let s = raw.trim().replace(/,+$/, '');

  // Strip surrounding quotes that may survive CSV/line parsing
  s = s.replace(/^["']+|["']+$/g, '').trim();

  // Strip leading glob * before a scheme letter
  s = s.replace(/^\*+(?=[a-zA-Z])/g, '').trim();

  // Remove all whitespace
  s = s.replace(/\s+/g, '');

  // Strip trailing wildcards and slashes (e.g. /* or *)
  const hadTrailingWildcard = /\*$/.test(s);
  s = s.replace(/[/*]+$/, '').trim();

  // Only clean up orphaned query artefacts when a trailing * was actually removed.
  // e.g. ?app_id=*  → strip * → ?app_id=  → clean → ?app_id
  //      ?a=1&b=*   → strip * → ?a=1&b=   → clean → ?a=1
  // Genuine incomplete queries (?token= with no preceding *) are left for the later filter.
  if (hadTrailingWildcard) {
    s = s.replace(/(?:&[^&=]*=?)$/, ''); // strip trailing &key= or &key artefact
    s = s.replace(/[=&?]+$/, '').trim(); // strip remaining orphaned = & ?
    s = s.replace(/\?$/, '').trim();     // strip empty query marker
  }

  if (!s) return null;

  // Fix single-slash scheme: https:/foo → https://foo
  if (opts.fixSchemes) {
    s = s.replace(/^(https?:)\/(?!\/)/i, '$1//');
  }

  // Detect scheme
  const schemeM = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeM) {
    const scheme = schemeM[1].toLowerCase();
    if (opts.filterNonHttp && !['http', 'https'].includes(scheme)) {
      return null; // non-HTTP scheme (app IDs, tel:, etc.)
    }
    // Strip scheme for uniform processing
    s = s.slice(schemeM[0].length).replace(/^\/\//, '');
  } else {
    // No scheme — check if looks like bare domain
    s = s.replace(/^\/\//, '');
  }

  // Strip wildcard host prefixes: *.domain.com → domain.com
  if (opts.stripWildcards) {
    s = s.replace(/^(\*\.)+/g, '');
    s = s.replace(/^\*+/g, '');
  }

  // Strip www.
  if (opts.stripWww) {
    s = s.replace(/^www\./i, '');
  }

  if (!s) return null;

  // Split into host:port and path
  const slashIdx = s.indexOf('/');
  let hostPort = slashIdx !== -1 ? s.slice(0, slashIdx) : s;
  let path = slashIdx !== -1 ? s.slice(slashIdx) : '';

  // Strip remaining inline wildcards from path
  if (opts.stripWildcards) {
    path = path.replace(/(\/?\*)+$/g, '').replace(/\/+$/, '');
  }

  // Strip paths if option enabled
  if (opts.stripPaths) {
    path = '';
  }

  // Validate host
  const host = hostPort.split(':')[0];
  const hostClean = host.replace(/^\.+/, '');

  // Must contain a dot
  if (!hostClean.includes('.')) return null;

  // Drop entries that start with a dot after cleaning
  if (hostClean.startsWith('.')) return null;

  // Drop known app-identifier TLDs
  if (opts.filterNonHttp) {
    const tld = hostClean.split('.').pop().toLowerCase();
    if (APP_TLDS.has(tld)) return null;
  }

  // Strip any leading dot from host:port artefact
  hostPort = hostPort.replace(/^\.+/, '');

  // Drop incomplete query strings (ends with = or &)
  const full = hostPort + path;
  if (opts.dropIncompleteQuery && /[=&]$/.test(full)) return null;

  // Detect port
  const hasPort = /:\d+/.test(hostPort);

  // Check if there is actually a valid TLD (must end in 2+ letter TLD)
  if (!/\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(full)) return null;

  const withScheme = 'https://' + full;
  const noScheme   = hasPort ? null : full; // port entries excluded from no-scheme

  // If user disabled addScheme but wants no-scheme list: noScheme stays as-is
  return { withScheme, noScheme, hasPort, raw };
}

/* ══════════════════════════════════════════════
   PROCESSING — orchestrate everything
   ══════════════════════════════════════════════ */

function process(inputText, opts) {
  const formatHint = document.querySelector('input[name="input-format"]:checked').value;
  const rawEntries = parseInput(inputText, formatHint);

  const results = {
    withScheme: [],
    noScheme: [],
    portsOnly: [],
    finalList: [],      // shape from opts.finalListPreset: full-https → all withScheme; else bare + https for ports
    finalPortCount: 0,  // entries with explicit :port (for legend / summary)
    skipped: [],
    totalInput: 0,
    validCount: 0,   // all successfully cleaned URLs, regardless of which outputs are on
    dupesRemoved: 0,
  };

  const allPieces = [];

  for (const entry of rawEntries) {
    results.totalInput++;
    const pieces = splitGlued(entry);
    for (const piece of pieces) {
      allPieces.push({ piece, original: entry });
    }
  }

  // If splitting produced more than original count, adjust totalInput
  // (keep totalInput as number of raw CSV/line entries)

  const seenWith = new Set();
  const seenNo   = new Set();

  for (const { piece, original } of allPieces) {
    const cleaned = cleanEntry(piece, opts);

    if (!cleaned) {
      results.skipped.push(piece || original);
      continue;
    }

    const { withScheme, noScheme, hasPort } = cleaned;

    // Deduplication is tracked against the canonical withScheme key
    const isDup = opts.dedup && seenWith.has(withScheme);
    if (isDup) {
      results.dupesRemoved++;
      continue; // skip dup across all output lists
    }
    seenWith.add(withScheme);
    results.validCount++;

    // With-scheme list
    if (opts.outWithScheme) {
      results.withScheme.push(withScheme);
    }

    // No-scheme list (port-based URLs excluded — no-scheme with port is invalid)
    if (opts.outNoScheme && noScheme) {
      if (!seenNo.has(noScheme)) {
        seenNo.add(noScheme);
        results.noScheme.push(noScheme);
      }
    }

    // Ports-only list
    if (opts.outPorts && hasPort) {
      results.portsOnly.push(withScheme);
    }

    // Final list — shape follows quick preset (see getFinalListPresetId)
    const flp = opts.finalListPreset || 'edge';
    if (flp === 'full-https') {
      results.finalList.push(withScheme);
      if (hasPort) results.finalPortCount++;
    } else {
      // edge & domains: bare host/path + https:// only when a port is present (Edge-friendly)
      if (hasPort) {
        results.finalList.push(withScheme);
        results.finalPortCount++;
      } else if (noScheme) {
        results.finalList.push(noScheme);
      }
    }
  }

  return results;
}

/* ══════════════════════════════════════════════
   JSON SERIALISATION
   ══════════════════════════════════════════════ */

function toJson(arr, compact) {
  if (arr.length === 0) return '[]';
  if (compact) {
    return '[' + arr.map(v => JSON.stringify(v)).join(',') + ']';
  }
  return JSON.stringify(arr, null, 2);
}

/* ══════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════ */

/**
 * Quick preset that controls Final List shape.
 * Active chip wins; else infer from toggles; custom mixes → Edge-style Final List.
 */
function getFinalListPresetId() {
  const active = document.querySelector('.preset-btn.active');
  if (active && ['edge', 'full-https', 'domains'].includes(active.dataset.preset)) {
    return active.dataset.preset;
  }
  const www   = document.getElementById('opt-strip-www').checked;
  const ows   = document.getElementById('opt-out-with-scheme').checked;
  const ons   = document.getElementById('opt-out-no-scheme').checked;
  const ports = document.getElementById('opt-out-ports').checked;
  if (!www && ows && ons && ports) return 'full-https';
  if (www && !ows && ons && !ports) return 'domains';
  return 'edge';
}

function getOpts() {
  return {
    stripWildcards:      document.getElementById('opt-strip-wildcards').checked,
    stripWww:            document.getElementById('opt-strip-www').checked,
    fixSchemes:          document.getElementById('opt-fix-schemes').checked,
    addScheme:           document.getElementById('opt-add-scheme').checked,
    dedup:               document.getElementById('opt-dedup').checked,
    filterNonHttp:       document.getElementById('opt-filter-non-http').checked,
    dropIncompleteQuery: document.getElementById('opt-drop-incomplete-query').checked,
    stripPaths:          document.getElementById('opt-strip-paths').checked,
    outWithScheme:       document.getElementById('opt-out-with-scheme').checked,
    outNoScheme:         document.getElementById('opt-out-no-scheme').checked,
    outPorts:            document.getElementById('opt-out-ports').checked,
    compact:             document.getElementById('opt-compact').checked,
    finalListPreset:     getFinalListPresetId(),
  };
}

const PRESET_HINTS = {
  edge:
    'Strip <code>www.</code> · all output tabs on · <strong>Final List</strong> = bare + <code>https://</code> for ports (Edge).',
  'full-https':
    'Keeps <code>www.</code> · <strong>Final List</strong> = every URL as <code>https://…</code> (same rows as With Scheme).',
  domains:
    'Bare in <strong>No Scheme</strong> · With Scheme / Ports off · <strong>Final List</strong> = same shape as Edge (bare + <code>https://</code> for ports).',
};

/** Rich copy for the (i) panels — keep in sync with processing behavior. */
const PRESET_DETAILS = {
  edge: `
    <p><strong>When to use:</strong> Microsoft Edge <strong>URL List</strong> and similar policies where you want one combined list.</p>
    <p><strong>What it sets:</strong> Strip <code>www.</code> · <strong>With Scheme</strong>, <strong>No Scheme</strong>, and <strong>Ports Only</strong> tabs all on.</p>
    <p><strong>Final List:</strong> Bare host/path when there is no port; <code>https://</code> is added only for URLs with an explicit port so Edge can parse them.</p>
  `,
  'full-https': `
    <p><strong>When to use:</strong> You need every <strong>Final List</strong> line to be a full URL with <code>https://</code>, while keeping <code>www.</code> when it appears in the input.</p>
    <p><strong>What it sets:</strong> <strong>Strip www</strong> unchecked (www preserved) · <strong>With Scheme</strong>, <strong>No Scheme</strong>, and <strong>Ports Only</strong> all on.</p>
    <p><strong>Final List:</strong> Same rows as <strong>With Scheme</strong> — every entry is <code>https://…</code>, including hosts without an explicit port.</p>
  `,
  domains: `
    <p><strong>When to use:</strong> Workflows that only need the bare <strong>No Scheme</strong> column (e.g. domain allowlists, some validators).</p>
    <p><strong>What it sets:</strong> Strip <code>www.</code> · <strong>No Scheme</strong> on · <strong>With Scheme</strong> and <strong>Ports Only</strong> off.</p>
    <p><strong>Final List:</strong> Same Edge-style rule as the first preset: bare when possible, <code>https://</code> only when a port is present (so port URLs stay valid).</p>
  `,
};

function initPresetDetailPanels() {
  document.querySelectorAll('.preset-detail-panel').forEach(panel => {
    const id = panel.id.replace(/^preset-detail-/, '');
    const html = PRESET_DETAILS[id];
    if (html) panel.innerHTML = html.trim();
  });
}

function closeAllPresetDetails() {
  document.querySelectorAll('.preset-detail-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.preset-info-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

function togglePresetDetail(btn) {
  const presetId = btn.dataset.presetInfo;
  if (!presetId) return;
  const panel = document.getElementById(`preset-detail-${presetId}`);
  if (!panel) return;
  const wasHidden = panel.classList.contains('hidden');
  closeAllPresetDetails();
  if (wasHidden) {
    panel.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }
}

function setPresetHint(presetId) {
  const el = document.getElementById('preset-hint');
  if (!el) return;
  el.innerHTML = PRESET_HINTS[presetId] || PRESET_HINTS.edge;
}

function setPresetButtonsActive(presetId) {
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === presetId);
  });
  document.querySelectorAll('.preset-card').forEach(card => {
    card.classList.toggle('preset-card-active', card.dataset.preset === presetId);
  });
}

/**
 * True while preset (or reset) is updating checkboxes programmatically.
 * Browsers may fire `change` on those updates; we must not clear the active preset chip.
 */
let _applyingOutputPreset = false;

/** Applies output-related toggles + Strip www. Does not change other cleaning options. */
function applyOutputPreset(presetId) {
  const id =
    presetId === 'full-https' || presetId === 'domains' ? presetId : 'edge';

  closeAllPresetDetails();

  _applyingOutputPreset = true;
  try {
    if (id === 'full-https') {
      document.getElementById('opt-strip-www').checked = false;
      document.getElementById('opt-out-with-scheme').checked = true;
      document.getElementById('opt-out-no-scheme').checked   = true;
      document.getElementById('opt-out-ports').checked       = true;
    } else if (id === 'domains') {
      document.getElementById('opt-strip-www').checked = true;
      document.getElementById('opt-out-with-scheme').checked = false;
      document.getElementById('opt-out-no-scheme').checked   = true;
      document.getElementById('opt-out-ports').checked       = false;
    } else {
      document.getElementById('opt-strip-www').checked = true;
      document.getElementById('opt-out-with-scheme').checked = true;
      document.getElementById('opt-out-no-scheme').checked   = true;
      document.getElementById('opt-out-ports').checked       = true;
    }
    setPresetButtonsActive(id);
    setPresetHint(id);
  } finally {
    _applyingOutputPreset = false;
  }
}

function clearPresetSelection() {
  if (_applyingOutputPreset) return;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('preset-card-active'));
}

/** If current toggles match a known preset, highlight it; otherwise no chip is active. */
function syncPresetFromDom() {
  if (_applyingOutputPreset) return;
  const www   = document.getElementById('opt-strip-www').checked;
  const ows   = document.getElementById('opt-out-with-scheme').checked;
  const ons   = document.getElementById('opt-out-no-scheme').checked;
  const ports = document.getElementById('opt-out-ports').checked;

  let id = null;
  if (www && ows && ons && ports) id = 'edge';
  else if (!www && ows && ons && ports) id = 'full-https';
  else if (www && !ows && ons && !ports) id = 'domains';

  if (id) {
    setPresetButtonsActive(id);
    setPresetHint(id);
  } else {
    clearPresetSelection();
    const el = document.getElementById('preset-hint');
    if (el) {
      el.innerHTML =
        'Custom mix — adjust toggles below, or pick a quick preset to reset output style.';
    }
  }
}

function setDefaultOpts() {
  _applyingOutputPreset = true;
  try {
    document.getElementById('opt-strip-wildcards').checked       = true;
    document.getElementById('opt-fix-schemes').checked           = true;
    document.getElementById('opt-add-scheme').checked            = true;
    document.getElementById('opt-dedup').checked                 = true;
    document.getElementById('opt-filter-non-http').checked       = true;
    document.getElementById('opt-drop-incomplete-query').checked = true;
    document.getElementById('opt-strip-paths').checked           = false;
    document.getElementById('opt-compact').checked               = true;
  } finally {
    _applyingOutputPreset = false;
  }
  applyOutputPreset('edge');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg || 'Copied!';
  toast.classList.remove('hidden');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 220);
  }, 1800);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap all case-insensitive occurrences of q in <mark> */
function highlightHtml(text, q) {
  const t = String(text);
  if (!q) return escapeHtml(t);
  const lower = t.toLowerCase();
  const qLower = q.toLowerCase();
  const ql = qLower.length;
  let out = '';
  let i = 0;
  while (i < t.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx === -1) {
      out += escapeHtml(t.slice(i));
      break;
    }
    out += escapeHtml(t.slice(i, idx));
    out += '<mark class="search-hit">' + escapeHtml(t.slice(idx, idx + ql)) + '</mark>';
    i = idx + ql;
  }
  return out;
}

function getActiveTabName() {
  const t = document.querySelector('#output-tabs .tab.active');
  return t ? t.dataset.tab : 'final-list';
}

function hasPortInUrl(u) {
  return /https?:\/\/[^/?#]+:\d+/i.test(String(u));
}

function setOutputSearchEnabled(on) {
  const input = document.getElementById('output-search-input');
  const hint  = document.getElementById('output-search-hint');
  input.disabled = !on;
  hint.classList.toggle('hidden', on);
  if (!on) {
    input.value = '';
    document.getElementById('output-search-clear').classList.add('hidden');
    document.getElementById('output-search-count').classList.add('hidden');
    const filteredEl = document.getElementById('output-search-filtered');
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    const tab = getActiveTabName();
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'panel-' + tab));
  }
}

/** Rebuild filtered list or restore tab panels based on output search text */
function refreshOutputSearch() {
  const q = document.getElementById('output-search-input').value.trim();
  const countEl = document.getElementById('output-search-count');
  const clearBtn = document.getElementById('output-search-clear');
  const filteredEl = document.getElementById('output-search-filtered');
  const tab = getActiveTabName();
  const items = lastOutputArrays[tab] || [];

  if (!q) {
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    countEl.classList.add('hidden');
    clearBtn.classList.add('hidden');
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'panel-' + tab));
    return;
  }

  clearBtn.classList.remove('hidden');
  const qLower = q.toLowerCase();
  const filtered = items.filter(u => String(u).toLowerCase().includes(qLower));
  countEl.textContent = `${filtered.length} / ${items.length} shown`;
  countEl.classList.remove('hidden');

  filteredEl.classList.remove('hidden');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  if (filtered.length === 0) {
    filteredEl.innerHTML = '<div class="fv-empty">No matches in this tab.</div>';
    return;
  }

  let html = '';
  for (const u of filtered) {
    const portCls = hasPortInUrl(u) ? ' fv-row-port' : '';
    html += `<div class="fv-row${portCls}">${highlightHtml(u, q)}</div>`;
  }
  html += '<div class="fv-footer">Copy / Download use the full list for this tab, not the filter.</div>';
  filteredEl.innerHTML = html;
}

function updateInputSearch() {
  const wrap = document.getElementById('input-search-wrap');
  const filteredEl = document.getElementById('input-search-filtered');

  if (wrap.classList.contains('hidden')) {
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    return;
  }

  const q = document.getElementById('input-search-input').value.trim();
  const countEl = document.getElementById('input-search-count');
  const clearBtn = document.getElementById('input-search-clear');
  const text = document.getElementById('url-input').value;
  const fmt = document.querySelector('input[name="input-format"]:checked');
  const hint = fmt ? fmt.value : 'auto';

  let entries = [];
  try {
    entries = parseInput(text, hint);
  } catch {
    entries = [];
  }
  if (entries.length === 0 && text.trim()) {
    entries = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (entries.length === 0) entries = [text.trim()];
  }

  if (!q) {
    clearBtn.classList.add('hidden');
    filteredEl.classList.add('hidden');
    filteredEl.innerHTML = '';
    if (!text.trim()) {
      countEl.classList.add('hidden');
    } else if (entries.length > 0) {
      countEl.textContent = `${entries.length} parsed entries — type to filter the list below`;
      countEl.classList.remove('hidden');
    } else {
      countEl.textContent = 'Could not parse — try another format';
      countEl.classList.remove('hidden');
    }
    return;
  }

  clearBtn.classList.remove('hidden');
  const qLower = q.toLowerCase();
  const matches = entries.filter(e => String(e).toLowerCase().includes(qLower));
  countEl.textContent = `${matches.length} of ${entries.length} entries match — shown in the list below (full paste unchanged)`;
  countEl.classList.remove('hidden');

  filteredEl.classList.remove('hidden');
  if (matches.length === 0) {
    filteredEl.innerHTML =
      '<div class="fv-empty">No entries match. Try another term or input format.</div>';
    return;
  }

  let html = '';
  for (const u of matches) {
    html += `<div class="fv-row">${highlightHtml(String(u), q)}</div>`;
  }
  html +=
    '<div class="fv-footer">The text box below still contains your full paste. <strong>Process URLs</strong> uses everything in that box, not only this list.</div>';
  filteredEl.innerHTML = html;
}

function switchTab(tabName) {
  document.querySelectorAll('#output-tabs .tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabName));
  refreshOutputSearch();
}

function downloadJson(content, filename) {
  const blob = new Blob([content], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function refreshFinalListDescription(presetId, entryCount) {
  const block = document.getElementById('final-list-descblock');
  if (!block) return;

  const legendFull = `<span class="final-legend"><span class="legend-dot legend-dot-plain"></span> <code>https://</code> without <code>:port</code> &nbsp; <span class="legend-dot legend-dot-port"></span> includes <code>:port</code></span>`;
  const legendEdge = `<span class="final-legend"><span class="legend-dot legend-dot-plain"></span> Bare domain/path &nbsp; <span class="legend-dot legend-dot-port"></span> <code>https://</code> (port detected)</span>`;

  if (!entryCount) {
    block.innerHTML =
      `<strong>Final List.</strong> Output shape follows your <strong>Quick preset</strong> below. Run <strong>Process URLs</strong> to generate. ${legendEdge}`;
    return;
  }

  if (presetId === 'full-https') {
    block.innerHTML =
      `<strong>Final List (Full URLs preset).</strong> Every entry is <code>https://…</code> (aligned with the With Scheme list). ${legendFull}`;
  } else {
    const label = presetId === 'domains' ? 'Domains' : 'Edge';
    block.innerHTML =
      `<strong>Final List (${label} preset).</strong> Bare host/path when possible — <code>https://</code> only when a port is present (Edge policy). ${legendEdge}`;
  }
}

/* ══════════════════════════════════════════════
   MAIN RUN
   ══════════════════════════════════════════════ */

function run() {
  const inputText = document.getElementById('url-input').value;
  if (!inputText.trim()) {
    document.getElementById('process-hint').textContent = 'Please paste some URLs first.';
    return;
  }
  document.getElementById('process-hint').textContent = '';

  const opts    = getOpts();
  const results = process(inputText, opts);
  const compact = opts.compact;

  const jsonFinal  = toJson(results.finalList, compact);
  const jsonWith   = toJson(results.withScheme, compact);
  const jsonNo     = toJson(results.noScheme, compact);
  const jsonPorts  = toJson(results.portsOnly, compact);
  const jsonSkip   = results.skipped.join('\n');

  // Populate outputs
  document.getElementById('out-final-list').value   = jsonFinal;
  document.getElementById('out-with-scheme').value  = jsonWith;
  document.getElementById('out-no-scheme').value    = jsonNo;
  document.getElementById('out-ports-only').value   = jsonPorts;
  document.getElementById('out-skipped-list').value = jsonSkip;

  // Final list summary + description (preset-aware)
  refreshFinalListDescription(opts.finalListPreset, results.finalList.length);

  const plainCount = results.finalList.length - results.finalPortCount;
  let summaryInner = '';
  if (results.finalList.length > 0) {
    if (opts.finalListPreset === 'full-https') {
      summaryInner =
        `<span class="fs-item">All <span class="fs-count">${results.finalList.length}</span> use <code>https://</code></span>` +
        (results.finalPortCount > 0
          ? `<span class="fs-item"><span class="fs-count fs-count-port">${results.finalPortCount}</span> include an explicit port</span>`
          : '') +
        `<span class="fs-item">Total: <span class="fs-count">${results.finalList.length}</span> entries</span>`;
    } else {
      summaryInner =
        `<span class="fs-item"><span class="fs-count fs-count-plain">${plainCount}</span> bare domain entries</span>` +
        (results.finalPortCount > 0
          ? `<span class="fs-item"><span class="fs-count fs-count-port">${results.finalPortCount}</span> port-based (<code>https://</code>)</span>`
          : '') +
        `<span class="fs-item">Total: <span class="fs-count">${results.finalList.length}</span> entries</span>`;
    }
  }
  document.getElementById('final-summary').innerHTML = summaryInner;

  // Badges
  document.getElementById('badge-final-list').textContent = results.finalList.length;
  document.getElementById('badge-with-scheme').textContent = results.withScheme.length;
  document.getElementById('badge-no-scheme').textContent   = results.noScheme.length;
  document.getElementById('badge-ports-only').textContent  = results.portsOnly.length;
  document.getElementById('badge-skipped').textContent     = results.skipped.length;

  // Stats — validCount is independent of which output tabs are enabled
  document.getElementById('stat-total').textContent   = results.totalInput;
  document.getElementById('stat-valid').textContent   = results.validCount;
  document.getElementById('stat-dedup').textContent   = results.dupesRemoved;
  document.getElementById('stat-skipped').textContent = results.skipped.length;
  document.getElementById('stat-ports').textContent   = results.portsOnly.length;

  // Show
  document.getElementById('stats-bar').classList.remove('hidden');
  document.getElementById('output-card').classList.remove('hidden');

  lastOutputArrays['final-list']   = results.finalList.slice();
  lastOutputArrays['with-scheme']  = results.withScheme.slice();
  lastOutputArrays['no-scheme']    = results.noScheme.slice();
  lastOutputArrays['ports-only']   = results.portsOnly.slice();
  lastOutputArrays['skipped-list'] = results.skipped.slice();

  setOutputSearchEnabled(true);
  document.getElementById('output-search-input').value = '';

  // Auto-switch to Final List if it has entries, otherwise first populated tab
  if (results.finalList.length > 0)       switchTab('final-list');
  else if (results.withScheme.length > 0) switchTab('with-scheme');
  else if (results.noScheme.length > 0)   switchTab('no-scheme');
  else if (results.portsOnly.length > 0)  switchTab('ports-only');
  else                                    switchTab('skipped-list');
}

/* ══════════════════════════════════════════════
   EVENT LISTENERS
   ══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  // Process
  document.getElementById('process-btn').addEventListener('click', run);

  // Ctrl/Cmd + Enter shortcut
  document.getElementById('url-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
  });

  // Clear input
  document.getElementById('clear-btn').addEventListener('click', () => {
    document.getElementById('url-input').value = '';
    document.getElementById('stats-bar').classList.add('hidden');
    document.getElementById('output-card').classList.add('hidden');
    document.getElementById('process-hint').textContent = '';
    setOutputSearchEnabled(false);
    document.getElementById('input-search-input').value = '';
    document.getElementById('input-search-count').classList.add('hidden');
    document.getElementById('input-search-clear').classList.add('hidden');
    updateInputSearch();
  });

  // Reset options
  document.getElementById('reset-options-btn').addEventListener('click', setDefaultOpts);

  initPresetDetailPanels();

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyOutputPreset(btn.dataset.preset));
  });

  document.querySelectorAll('.preset-info-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      togglePresetDetail(btn);
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllPresetDetails();
  });

  document.getElementById('options-card').addEventListener('click', e => {
    if (e.target.closest('.preset-info-btn') || e.target.closest('.preset-detail-panel')) return;
    if (!e.target.closest('.preset-card-top')) closeAllPresetDetails();
  });

  ['opt-strip-www', 'opt-out-with-scheme', 'opt-out-no-scheme', 'opt-out-ports'].forEach(id => {
    document.getElementById(id).addEventListener('change', syncPresetFromDom);
  });

  // File upload
  document.getElementById('file-upload').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      document.getElementById('url-input').value = evt.target.result;
      updateInputSearch();
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  });

  // Tab switching (output only)
  document.querySelectorAll('#output-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.getElementById('input-search-toggle').addEventListener('click', () => {
    const wrap = document.getElementById('input-search-wrap');
    const btn = document.getElementById('input-search-toggle');
    wrap.classList.toggle('hidden');
    const visible = !wrap.classList.contains('hidden');
    btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (visible) document.getElementById('input-search-input').focus();
    updateInputSearch();
  });

  document.getElementById('input-search-input').addEventListener('input', updateInputSearch);
  document.getElementById('input-search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      updateInputSearch();
      const panel = document.getElementById('input-search-filtered');
      if (!panel.classList.contains('hidden') && panel.innerHTML) {
        panel.scrollTop = 0;
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  });
  document.getElementById('input-search-clear').addEventListener('click', () => {
    document.getElementById('input-search-input').value = '';
    updateInputSearch();
    document.getElementById('input-search-input').focus();
  });

  document.getElementById('url-input').addEventListener('input', updateInputSearch);

  document.querySelectorAll('input[name="input-format"]').forEach(r => {
    r.addEventListener('change', updateInputSearch);
  });

  document.getElementById('output-search-input').addEventListener('input', refreshOutputSearch);
  document.getElementById('output-search-clear').addEventListener('click', () => {
    document.getElementById('output-search-input').value = '';
    refreshOutputSearch();
    document.getElementById('output-search-input').focus();
  });

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = {
        'final-list':   'out-final-list',
        'with-scheme':  'out-with-scheme',
        'no-scheme':    'out-no-scheme',
        'ports-only':   'out-ports-only',
        'skipped-list': 'out-skipped-list',
      }[btn.dataset.copy];
      const text = document.getElementById(id).value;
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!'));
    });
  });

  // Download buttons
  document.querySelectorAll('[data-download]').forEach(btn => {
    btn.addEventListener('click', () => {
      const map = {
        'final-list':  { id: 'out-final-list',  name: 'urls-final-list.json' },
        'with-scheme': { id: 'out-with-scheme',  name: 'urls-with-scheme.json' },
        'no-scheme':   { id: 'out-no-scheme',    name: 'urls-no-scheme.json' },
        'ports-only':  { id: 'out-ports-only',   name: 'urls-ports-only.json' },
      };
      const cfg = map[btn.dataset.download];
      if (!cfg) return;
      const content = document.getElementById(cfg.id).value;
      downloadJson(content, cfg.name);
    });
  });

  updateInputSearch();
  syncPresetFromDom();
});
