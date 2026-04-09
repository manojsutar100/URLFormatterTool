'use strict';

/* ── Inline the core logic so we can test in Node without a browser DOM ── */

const APP_TLDS = new Set(['controller', 'mpassplus', 'android', 'ios']);

function detectFormat(text) {
  const t = text.trim();
  if (t.startsWith('[')) return 'json';
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const csvLike = lines.some(l => (l.startsWith('"') && l.includes(',')) || l.split(',').length > 2);
    if (csvLike) return 'csv';
    return 'lines';
  }
  if (t.includes(',')) return 'csv';
  return 'lines';
}

function parseCsvRow(text) {
  const results = [];
  let current = '', inQuotes = false;
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

function parseInput(text, formatHint = 'auto') {
  const format = formatHint === 'auto' ? detectFormat(text) : formatHint;
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }
  if (format === 'csv') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
      if (line.includes(',') || line.startsWith('"')) {
        results.push(...parseCsvRow(line));
      } else {
        const v = line.replace(/^["']+|["']+$/g, '').trim();
        if (v) results.push(v);
      }
    }
    return results;
  }
  return text.split('\n').map(l => l.trim().replace(/^["']+|["']+$/g, '').trim()).filter(Boolean);
}

function splitGlued(value) {
  return value.split(/(?=https?:\/\/)/i).map(s => s.trim()).filter(Boolean);
}

const DEFAULT_OPTS = {
  stripWildcards: true, stripWww: true, fixSchemes: true, addScheme: true,
  dedup: true, filterNonHttp: true, dropIncompleteQuery: true, stripPaths: false,
  outWithScheme: true, outNoScheme: true, outPorts: true, compact: true,
};

function cleanEntry(raw, opts = DEFAULT_OPTS) {
  let s = raw.trim().replace(/,+$/, '');
  s = s.replace(/^["']+|["']+$/g, '').trim();
  s = s.replace(/^\*+(?=[a-zA-Z])/g, '').trim();
  s = s.replace(/\s+/g, '');
  s = s.replace(/[/*]+$/, '').trim();
  if (!s) return null;
  if (opts.fixSchemes) s = s.replace(/^(https?:)\/(?!\/)/i, '$1//');
  const schemeM = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeM) {
    const scheme = schemeM[1].toLowerCase();
    if (opts.filterNonHttp && !['http', 'https'].includes(scheme)) return null;
    s = s.slice(schemeM[0].length).replace(/^\/\//, '');
  } else {
    s = s.replace(/^\/\//, '');
  }
  if (opts.stripWildcards) { s = s.replace(/^(\*\.)+/g, ''); s = s.replace(/^\*+/g, ''); }
  if (opts.stripWww) s = s.replace(/^www\./i, '');
  if (!s) return null;
  const slashIdx = s.indexOf('/');
  let hostPort = slashIdx !== -1 ? s.slice(0, slashIdx) : s;
  let path     = slashIdx !== -1 ? s.slice(slashIdx) : '';
  if (opts.stripWildcards) path = path.replace(/(\/?\*)+$/g, '').replace(/\/+$/, '');
  if (opts.stripPaths) path = '';
  const host      = hostPort.split(':')[0];
  const hostClean = host.replace(/^\.+/, '');
  if (!hostClean.includes('.'))    return null;
  if (hostClean.startsWith('.'))   return null;
  if (opts.filterNonHttp) {
    const tld = hostClean.split('.').pop().toLowerCase();
    if (APP_TLDS.has(tld)) return null;
  }
  hostPort = hostPort.replace(/^\.+/, '');
  const full = hostPort + path;
  if (opts.dropIncompleteQuery && /[=&]$/.test(full)) return null;
  const hasPort = /:\d+/.test(hostPort);
  if (!/\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(full)) return null;
  return { withScheme: 'https://' + full, noScheme: hasPort ? null : full, hasPort };
}

/* ── Test runner ── */

let pass = 0, fail = 0;

function test(label, input, expectedWith, expectedNo = undefined) {
  const result = cleanEntry(input);
  const gotWith = result ? result.withScheme : null;
  const gotNo   = result ? result.noScheme   : null;
  const okWith  = gotWith === expectedWith;
  const okNo    = expectedNo === undefined ? true : gotNo === expectedNo;
  if (okWith && okNo) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    if (!okWith) console.log(`      withScheme: expected "${expectedWith}" got "${gotWith}"`);
    if (!okNo)   console.log(`      noScheme:   expected "${expectedNo}"   got "${gotNo}"`);
    fail++;
  }
}

function testParse(label, input, format, expected) {
  const result = parseInput(input, format);
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      got:      ${JSON.stringify(result)}`);
    fail++;
  }
}

console.log('\n═══ FORMAT DETECTION & PARSING ═══\n');

testParse('Single-line plain URL',
  'https://company.com',
  'auto',
  ['https://company.com']
);

testParse('One per line (plain)',
  'https://a.com\nhttps://b.com\nhttps://c.com',
  'auto',
  ['https://a.com', 'https://b.com', 'https://c.com']
);

testParse('JSON array',
  '["https://a.com","https://b.com"]',
  'auto',
  ['https://a.com', 'https://b.com']
);

testParse('Single-line CSV (auto-detect)',
  '"https://a.com","https://b.com","https://c.com"',
  'auto',
  ['https://a.com', 'https://b.com', 'https://c.com']
);

testParse('Single-line CSV unquoted (auto-detect)',
  'https://a.com,https://b.com,https://c.com',
  'auto',
  ['https://a.com', 'https://b.com', 'https://c.com']
);

testParse('Multi-line quoted CSV',
  '"https://a.com","https://b.com"\n"https://c.com","https://d.com"',
  'auto',
  ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']
);

testParse('Quoted lines (lines with surrounding quotes)',
  '"https://a.com"\n"https://b.com"',
  'auto',
  ['https://a.com', 'https://b.com']
);

testParse('Force CSV mode on multi-line',
  'https://a.com\nhttps://b.com',
  'csv',
  ['https://a.com', 'https://b.com']
);


console.log('\n═══ CLEANING — Normal cases ═══\n');

test('Plain HTTPS URL',
  'https://company.com',
  'https://company.com', 'company.com'
);

test('HTTP URL → https://',
  'http://company.com',
  'https://company.com', 'company.com'
);

test('Bare domain (no scheme)',
  'company.com',
  'https://company.com', 'company.com'
);

test('Bare domain with www',
  'www.company.com',
  'https://company.com', 'company.com'
);

test('URL with www and https://',
  'https://www.company.com',
  'https://company.com', 'company.com'
);

test('URL with trailing /*',
  'https://company.com/*',
  'https://company.com', 'company.com'
);

test('URL with trailing /',
  'https://company.com/',
  'https://company.com', 'company.com'
);

test('URL with path',
  'https://company.com/portal/login',
  'https://company.com/portal/login', 'company.com/portal/login'
);

test('Subdomain URL',
  'mail.company.com',
  'https://mail.company.com', 'mail.company.com'
);


console.log('\n═══ CLEANING — Wildcard cases ═══\n');

test('Wildcard prefix *.company.com',
  '*.company.com',
  'https://company.com', 'company.com'
);

test('Wildcard with trailing /*',
  '*.company.com/*',
  'https://company.com', 'company.com'
);

test('https://*.company.com',
  'https://*.company.com',
  'https://company.com', 'company.com'
);

test('https://*.company.com/*',
  'https://*.company.com/*',
  'https://company.com', 'company.com'
);

test('Deep wildcard *.sub.company.com',
  '*.sub.company.com',
  'https://sub.company.com', 'sub.company.com'
);


console.log('\n═══ CLEANING — Broken schemes ═══\n');

test('https:/ (single slash)',
  'https:/company.com',
  'https://company.com', 'company.com'
);

test('https:// (correct)',
  'https://company.com',
  'https://company.com', 'company.com'
);

test('Quoted URL (CSV artefact)',
  '"https://company.com"',
  'https://company.com', 'company.com'
);

test('Quoted bare domain',
  '"company.com"',
  'https://company.com', 'company.com'
);


console.log('\n═══ CLEANING — Port numbers ═══\n');

test('URL with port (withScheme only, noScheme=null)',
  'https://internal.company.com:8080',
  'https://internal.company.com:8080', null
);

test('Port + path',
  'https://service.company.com:8453/api/v1',
  'https://service.company.com:8453/api/v1', null
);

test('URL with :443 (standard HTTPS port)',
  'https://login.provider.com:443/oam/fed',
  'https://login.provider.com:443/oam/fed', null
);

test('URL with :444 (non-standard port)',
  'https://account.azure.com:444',
  'https://account.azure.com:444', null
);


console.log('\n═══ CLEANING — Edge cases & invalid entries ═══\n');

test('Non-HTTP scheme (app ID format)',
  'mobilepassplus://autoenrollment?org=acme',
  null
);

test('Android app ID',
  'com.vendor.appname.android',
  null
);

test('No TLD (single label)',
  'localhost',
  null
);

test('Incomplete query string (ends with =)',
  'https://company.com/auth?token=',
  null
);

test('Incomplete query string (ends with &)',
  'https://company.com/auth?a=1&',
  null
);

test('Valid query string (not incomplete)',
  'https://company.com/auth?a=1&b=2',
  'https://company.com/auth?a=1&b=2', 'company.com/auth?a=1&b=2'
);

test('Glued scheme prefix stripped',
  '*https://company.com',
  'https://company.com', 'company.com'
);

test('Leading dot (leftover from *.)',
  '.company.com',
  'https://company.com', 'company.com'
);

test('Spaces in URL',
  'https://company .com',
  'https://company.com', 'company.com'
);

test('Country-code TLD (.io)',
  'app.aquilai.io',
  'https://app.aquilai.io', 'app.aquilai.io'
);

test('Long TLD (.cloud)',
  'service.oraclecloud.com',
  'https://service.oraclecloud.com', 'service.oraclecloud.com'
);

test('Subdomain + port + path (real-world from BYOD)',
  'https://ekjx.login.em2.oraclecloud.com:443/oam/fed',
  'https://ekjx.login.em2.oraclecloud.com:443/oam/fed', null
);


console.log('\n═══ GLUED URL SPLITTING ═══\n');

const glued = 'https://a.comhttps://b.com';
const pieces = splitGlued(glued);
const gluedOk = JSON.stringify(pieces) === JSON.stringify(['https://a.com', 'https://b.com']);
if (gluedOk) { console.log('  ✓ Glued URLs split correctly'); pass++; }
else { console.log(`  ✗ Glued split: expected ["https://a.com","https://b.com"] got ${JSON.stringify(pieces)}`); fail++; }


console.log('\n═══ DEDUPLICATION ═══\n');

const dupeInput = 'https://a.com\nhttps://a.com\nhttps://b.com\nhttp://a.com';
const entries = parseInput(dupeInput, 'lines');
const seen = new Set();
let validCount = 0, dupeCount = 0;
for (const e of entries) {
  const c = cleanEntry(e);
  if (!c) continue;
  if (seen.has(c.withScheme)) { dupeCount++; continue; }
  seen.add(c.withScheme);
  validCount++;
}
const dupeOk = validCount === 2 && dupeCount === 2;
if (dupeOk) { console.log('  ✓ Deduplication: 4 inputs → 2 unique, 2 dupes'); pass++; }
else { console.log(`  ✗ Deduplication: expected 2 unique/2 dupes, got ${validCount}/${dupeCount}`); fail++; }


console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail === 0) console.log('All tests passed ✓');
else console.log(`${fail} test(s) FAILED ✗`);
console.log('');
