/**
 * Standalone check: preset toggle targets match app.js applyOutputPreset.
 * Run: node check_presets.mjs
 */
const rows = {
  edge: { www: true, ows: true, ons: true, ports: true },
  'full-https': { www: false, ows: true, ons: true, ports: true },
  domains: { www: true, ows: false, ons: true, ports: false },
};

function inferPreset(www, ows, ons, ports) {
  for (const [name, r] of Object.entries(rows)) {
    if (r.www === www && r.ows === ows && r.ons === ons && r.ports === ports) return name;
  }
  return null;
}

let bad = 0;
for (const [name, r] of Object.entries(rows)) {
  const g = inferPreset(r.www, r.ows, r.ons, r.ports);
  if (g !== name) {
    console.error(`FAIL infer ${name} -> ${g}`);
    bad++;
  }
}
if (inferPreset(true, true, true, false) !== null) {
  console.error('FAIL custom should not match');
  bad++;
}
if (bad === 0) console.log('check_presets.mjs: OK');
process.exit(bad ? 1 : 0);
