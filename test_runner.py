"""Python port of the URL formatter logic for offline testing."""
import re, csv as _csv, json

APP_TLDS = {'controller', 'mpassplus', 'android', 'ios'}

# ── Format detection ──────────────────────────────────────────────────────────

def detect_format(text: str) -> str:
    t = text.strip()
    if t.startswith('['):
        return 'json'
    lines = [l.strip() for l in t.splitlines() if l.strip()]
    if len(lines) > 1:
        csv_like = any((l.startswith('"') and ',' in l) or l.count(',') > 1 for l in lines)
        if csv_like:
            return 'csv'
        return 'lines'
    if ',' in t:
        return 'csv'
    return 'lines'

def parse_csv_row(text: str) -> list[str]:
    reader = _csv.reader([text], quotechar='"', doublequote=True, skipinitialspace=True)
    row = next(reader, [])
    return [v.strip() for v in row if v.strip()]

def parse_input(text: str, hint: str = 'auto') -> list[str]:
    fmt = detect_format(text) if hint == 'auto' else hint
    if fmt == 'json':
        try:
            parsed = json.loads(text.strip())
            if isinstance(parsed, list):
                return [str(v) for v in parsed]
        except Exception:
            pass
    if fmt == 'csv':
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        results = []
        for line in lines:
            if ',' in line or line.startswith('"'):
                results.extend(parse_csv_row(line))
            else:
                v = line.strip('"\'').strip()
                if v:
                    results.append(v)
        return results
    # lines mode — strip surrounding quotes
    return [l.strip().strip('"\'').strip() for l in text.splitlines() if l.strip()]

def split_glued(value: str) -> list[str]:
    return [p for p in re.split(r'(?=https?://)', value.strip(), flags=re.IGNORECASE) if p]

# ── Cleaning ──────────────────────────────────────────────────────────────────

class Opts:
    strip_wildcards = True
    strip_www = True
    fix_schemes = True
    add_scheme = True
    dedup = True
    filter_non_http = True
    drop_incomplete_query = True
    strip_paths = False

def clean_entry(raw: str, opts=Opts()) -> dict | None:
    s = raw.strip().rstrip(',')
    # Strip surrounding quotes
    s = s.strip('"\'')
    # Strip leading glob *
    s = re.sub(r'^\*+(?=[a-zA-Z])', '', s).strip()
    # Remove whitespace
    s = re.sub(r'\s+', '', s)
    # Strip trailing wildcards/slashes
    had_trailing_wildcard = s.endswith('*')
    s = re.sub(r'[/*]+$', '', s).strip()

    # Only clean up orphaned query artefacts when a trailing * was actually removed.
    if had_trailing_wildcard:
        s = re.sub(r'(?:&[^&=]*=?)$', '', s)   # strip trailing &key= or &key
        s = re.sub(r'[=&?]+$', '', s).strip()  # strip remaining orphaned = & ?
        s = s.rstrip('?').strip()               # strip empty query marker

    if not s:
        return None

    # Fix single-slash scheme
    if opts.fix_schemes:
        s = re.sub(r'^(https?:)/(?!/)', r'\1//', s, flags=re.IGNORECASE)

    # Detect scheme
    scheme_m = re.match(r'^([a-z][a-z0-9+.-]*):', s, re.IGNORECASE)
    if scheme_m:
        scheme = scheme_m.group(1).lower()
        if opts.filter_non_http and scheme not in ('http', 'https'):
            return None
        s = s[len(scheme_m.group(0)):]
        s = re.sub(r'^//', '', s)
    else:
        s = re.sub(r'^//', '', s)

    # Strip wildcard host prefixes
    if opts.strip_wildcards:
        s = re.sub(r'^(\*\.)+', '', s)
        s = re.sub(r'^\*+', '', s)

    # Strip www.
    if opts.strip_www:
        s = re.sub(r'^www\.', '', s, flags=re.IGNORECASE)

    if not s:
        return None

    slash = s.find('/')
    host_port = s[:slash] if slash != -1 else s
    path      = s[slash:] if slash != -1 else ''

    if opts.strip_wildcards:
        path = re.sub(r'(\/?\*)+$', '', path).rstrip('/')
    if opts.strip_paths:
        path = ''

    host       = host_port.split(':')[0]
    host_clean = host.lstrip('.')

    if '.' not in host_clean:
        return None
    if host_clean.startswith('.'):
        return None
    if opts.filter_non_http:
        tld = host_clean.rsplit('.', 1)[-1].lower()
        if tld in APP_TLDS:
            return None

    host_port = host_port.lstrip('.')
    full = host_port + path

    if opts.drop_incomplete_query and re.search(r'[=&]$', full):
        return None

    has_port = bool(re.search(r':\d+', host_port))

    if not re.search(r'\.[a-z]{2,}(:\d+)?([/?#].*)?$', full, re.IGNORECASE):
        return None

    return {
        'withScheme': 'https://' + full,
        'noScheme':   None if has_port else full,
        'hasPort':    has_port,
    }

# ── Test harness ──────────────────────────────────────────────────────────────

passed = 0
failed = 0

def test(label, raw, expected_with, expected_no='__skip__'):
    global passed, failed
    result = clean_entry(raw)
    got_with = result['withScheme'] if result else None
    got_no   = result['noScheme']   if result else '__missing__'
    ok_with  = got_with == expected_with
    ok_no    = expected_no == '__skip__' or got_no == expected_no
    if ok_with and ok_no:
        print(f'  ✓ {label}')
        passed += 1
    else:
        print(f'  ✗ {label}')
        if not ok_with:
            print(f'      withScheme: expected "{expected_with}" got "{got_with}"')
        if not ok_no:
            print(f'      noScheme:   expected "{expected_no}"   got "{got_no}"')
        failed += 1


def test_clean_opts(label, raw, opts, expected_with, expected_no='__skip__'):
    global passed, failed
    result = clean_entry(raw, opts)
    got_with = result['withScheme'] if result else None
    got_no   = result['noScheme']   if result else '__missing__'
    ok_with  = got_with == expected_with
    ok_no    = expected_no == '__skip__' or got_no == expected_no
    if ok_with and ok_no:
        print(f'  ✓ {label}')
        passed += 1
    else:
        print(f'  ✗ {label}')
        if not ok_with:
            print(f'      withScheme: expected "{expected_with}" got "{got_with}"')
        if not ok_no:
            print(f'      noScheme:   expected "{expected_no}"   got "{got_no}"')
        failed += 1

def test_parse(label, text, fmt, expected):
    global passed, failed
    result = parse_input(text, fmt)
    if result == expected:
        print(f'  ✓ {label}')
        passed += 1
    else:
        print(f'  ✗ {label}')
        print(f'      expected: {expected}')
        print(f'      got:      {result}')
        failed += 1

# ─── Output presets (mirror app.js applyOutputPreset) ─────────────────────────
print('\n═══ OUTPUT PRESETS (strip_www, out_ws, out_ns, out_ports) ═══\n')

PRESET_TOGGLE_ROWS = {
    'edge':       (True, True, True, True),
    'full-https': (False, True, True, True),
    'domains':    (True, False, True, False),
}


def infer_preset(www: bool, ows: bool, ons: bool, ports: bool) -> str | None:
    for name, row in PRESET_TOGGLE_ROWS.items():
        if row == (www, ows, ons, ports):
            return name
    return None


for name, row in PRESET_TOGGLE_ROWS.items():
    got = infer_preset(*row)
    if got == name:
        print(f'  ✓ Preset {name!r} round-trips infer_preset')
        passed += 1
    else:
        print(f'  ✗ Preset {name!r} infer_preset got {got!r}')
        failed += 1

# Custom mix should not match any preset
if infer_preset(True, True, True, False) is None and infer_preset(False, False, True, True) is None:
    print('  ✓ Custom toggle mixes do not falsely match a preset')
    passed += 1
else:
    print('  ✗ Custom mixes incorrectly matched a preset')
    failed += 1

# ─── Full-https preset keeps www (Opts.strip_www = False) ─────────────────────
print('\n═══ PRESET: FULL HTTPS (keep www) ═══\n')


class OptsKeepWww(Opts):
    strip_www = False


test_clean_opts(
    'strip_www off keeps host www',
    'https://www.bank.example.com/app',
    OptsKeepWww(),
    'https://www.bank.example.com/app',
    'www.bank.example.com/app',
)
test_clean_opts(
    'strip_www off bare www domain',
    'www.shop.example.com',
    OptsKeepWww(),
    'https://www.shop.example.com',
    'www.shop.example.com',
)

# ─── Format detection & parsing ───────────────────────────────────────────────
print('\n═══ FORMAT DETECTION & PARSING ═══\n')

test_parse('Single plain URL', 'https://company.com', 'auto', ['https://company.com'])
test_parse('One per line', 'https://a.com\nhttps://b.com\nhttps://c.com', 'auto',
           ['https://a.com', 'https://b.com', 'https://c.com'])
test_parse('JSON array', '["https://a.com","https://b.com"]', 'auto',
           ['https://a.com', 'https://b.com'])
test_parse('Single-line quoted CSV', '"https://a.com","https://b.com","https://c.com"', 'auto',
           ['https://a.com', 'https://b.com', 'https://c.com'])
test_parse('Single-line unquoted CSV', 'https://a.com,https://b.com,https://c.com', 'auto',
           ['https://a.com', 'https://b.com', 'https://c.com'])
test_parse('Multi-line quoted CSV',
           '"https://a.com","https://b.com"\n"https://c.com","https://d.com"', 'auto',
           ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'])
test_parse('Quoted lines (surrounding quotes stripped)',
           '"https://a.com"\n"https://b.com"', 'auto',
           ['https://a.com', 'https://b.com'])

# ─── Normal cleaning ──────────────────────────────────────────────────────────
print('\n═══ CLEANING — Normal cases ═══\n')

test('Plain HTTPS URL', 'https://company.com', 'https://company.com', 'company.com')
test('HTTP URL → https://', 'http://company.com', 'https://company.com', 'company.com')
test('Bare domain', 'company.com', 'https://company.com', 'company.com')
test('www domain (bare)', 'www.company.com', 'https://company.com', 'company.com')
test('https://www.company.com', 'https://www.company.com', 'https://company.com', 'company.com')
test('Trailing /*', 'https://company.com/*', 'https://company.com', 'company.com')
test('Trailing /', 'https://company.com/', 'https://company.com', 'company.com')
test('URL with path', 'https://company.com/portal/login', 'https://company.com/portal/login', 'company.com/portal/login')
test('Subdomain', 'mail.company.com', 'https://mail.company.com', 'mail.company.com')

# ─── Wildcards ────────────────────────────────────────────────────────────────
print('\n═══ CLEANING — Wildcard cases ═══\n')

test('*.company.com', '*.company.com', 'https://company.com', 'company.com')
test('*.company.com/*', '*.company.com/*', 'https://company.com', 'company.com')
test('https://*.company.com', 'https://*.company.com', 'https://company.com', 'company.com')
test('https://*.company.com/*', 'https://*.company.com/*', 'https://company.com', 'company.com')
test('*.sub.company.com', '*.sub.company.com', 'https://sub.company.com', 'sub.company.com')

# ─── Broken schemes ───────────────────────────────────────────────────────────
print('\n═══ CLEANING — Broken schemes ═══\n')

test('https:/ (single slash)', 'https:/company.com', 'https://company.com', 'company.com')
test('Quoted HTTPS URL', '"https://company.com"', 'https://company.com', 'company.com')
test('Quoted bare domain', '"company.com"', 'https://company.com', 'company.com')

# ─── Ports ────────────────────────────────────────────────────────────────────
print('\n═══ CLEANING — Port numbers ═══\n')

test('Port 8080', 'https://internal.company.com:8080', 'https://internal.company.com:8080', None)
test('Port + path', 'https://service.company.com:8453/api/v1', 'https://service.company.com:8453/api/v1', None)
test('Port 443 + path', 'https://login.provider.com:443/oam/fed', 'https://login.provider.com:443/oam/fed', None)
test('Port 444', 'https://account.azure.com:444', 'https://account.azure.com:444', None)

# ─── Invalid / edge cases ─────────────────────────────────────────────────────
print('\n═══ CLEANING — Invalid / edge cases ═══\n')

test('Non-HTTP scheme', 'mobilepassplus://autoenrollment?org=acme', None)
test('Android app ID (TLD=android)', 'com.vendor.appname.android', None)
test('No TLD (localhost)', 'localhost', None)
test('Incomplete query (ends =)', 'https://company.com/auth?token=', None)
test('Incomplete query (ends &)', 'https://company.com/auth?a=1&', None)
test('Valid query string', 'https://company.com/auth?a=1&b=2', 'https://company.com/auth?a=1&b=2', 'company.com/auth?a=1&b=2')
test('Wildcard query value (?app_id=*) → param name preserved',
     'https://consent.digilocker.gov.in/consent-form?app_id=*',
     'https://consent.digilocker.gov.in/consent-form?app_id',
     'consent.digilocker.gov.in/consent-form?app_id')
test('Wildcard mid-query (?a=1&b=*) → orphaned &b= stripped',
     'https://company.com/page?a=1&b=*',
     'https://company.com/page?a=1',
     'company.com/page?a=1')
test('Spaces in URL', 'https://company .com', 'https://company.com', 'company.com')
test('Country-code TLD .io', 'app.aquilai.io', 'https://app.aquilai.io', 'app.aquilai.io')
test('Oracle Cloud real-world URL', 'https://ekjx.login.em2.oraclecloud.com:443/oam/fed',
     'https://ekjx.login.em2.oraclecloud.com:443/oam/fed', None)
test('Leading dot bare domain', '.company.com', 'https://company.com', 'company.com')

# ─── Glued URLs ───────────────────────────────────────────────────────────────
print('\n═══ GLUED URL SPLITTING ═══\n')

glued = 'https://a.comhttps://b.com'
pieces = split_glued(glued)
expected_pieces = ['https://a.com', 'https://b.com']
if pieces == expected_pieces:
    print('  ✓ Glued URLs split correctly')
    passed += 1
else:
    print(f'  ✗ Glued split: expected {expected_pieces} got {pieces}')
    failed += 1

# ─── Deduplication ────────────────────────────────────────────────────────────
print('\n═══ DEDUPLICATION ═══\n')

dupe_input = 'https://a.com\nhttps://a.com\nhttps://b.com\nhttp://a.com'
entries = parse_input(dupe_input, 'lines')
seen = set()
valid_count = 0
dupe_count = 0
for e in entries:
    c = clean_entry(e)
    if not c:
        continue
    if c['withScheme'] in seen:
        dupe_count += 1
        continue
    seen.add(c['withScheme'])
    valid_count += 1

if valid_count == 2 and dupe_count == 2:
    print('  ✓ Deduplication: 4 inputs → 2 unique, 2 dupes (http://a.com == https://a.com)')
    passed += 1
else:
    print(f'  ✗ Deduplication: expected 2 unique / 2 dupes, got {valid_count} / {dupe_count}')
    failed += 1

# ─── Summary ──────────────────────────────────────────────────────────────────
print(f'\n{"─" * 50}')
print(f'Results: {passed} passed, {failed} failed')
print('All tests passed ✓' if failed == 0 else f'{failed} test(s) FAILED ✗')
print()
