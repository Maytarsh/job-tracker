#!/usr/bin/env python3
"""Run test/logic_tests.js against the .gs sources in headless Firefox.

Apps Script has no local runtime, so this loads the source files into a real JS
engine with the Google services stubbed out. Covers pure logic only - anything
touching Gmail, Sheets or the API is exercised in the Apps Script editor instead.
"""
import glob, json, logging, os, sys
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

STUBS = """
var Logger = { log: function () {} };
var Utilities = { sleep: function () {} };

// A real key/value store rather than a constant, because the poll cursor now
// lives in user properties and the tests have to show the two kinds staying
// apart - a stub that answered everything the same would hide exactly the
// mix-up that loses a second mailbox's mail.
function fakeStore_(seed) {
  var data = seed || {};
  return {
    _data: data,
    getProperty: function (k) { return k in data ? data[k] : null; },
    setProperty: function (k, v) { data[k] = String(v); },
    deleteProperty: function (k) { delete data[k]; }
  };
}
var SCRIPT_PROPS_ = fakeStore_({ ANTHROPIC_API_KEY: 'stub-key' });
var USER_PROPS_ = fakeStore_({});
var PropertiesService = {
  getScriptProperties: function () { return SCRIPT_PROPS_; },
  getUserProperties: function () { return USER_PROPS_; }
};

var LOCK_HELD_ = false;
var LockService = {
  getScriptLock: function () {
    return {
      tryLock: function () {
        if (LOCK_HELD_) return false;
        LOCK_HELD_ = true;
        return true;
      },
      releaseLock: function () { LOCK_HELD_ = false; }
    };
  }
};

var MAILBOX_STUB_ = 'first@gmail.com';
var Session = {
  getEffectiveUser: function () {
    return { getEmail: function () { return MAILBOX_STUB_; } };
  }
};

var UrlFetchApp = { fetch: function () { throw new Error('no network in logic tests'); } };
var GmailApp = { search: function () { return []; } };
var SpreadsheetApp = { getActive: function () { throw new Error('no sheet in logic tests'); } };
var ScriptApp = { getProjectTriggers: function () { return []; } };
"""

def build_page():
    """Write the harness to a real file - Firefox refuses top-level data: URLs."""
    src = [STUBS]
    # Alphabetical, because that is the order Apps Script evaluates project
    # files in - NOT dependency order. Loading them any other way here would
    # hide load-order bugs that would then only show up in production.
    for path in sorted(glob.glob(os.path.join(ROOT, 'src', '*.gs'))):
        with open(path, encoding='utf-8') as fh:
            src.append(fh.read())
    with open(os.path.join(ROOT, 'test', 'logic_tests.js'), encoding='utf-8') as fh:
        src.append(fh.read())

    page = (
        "<!doctype html><meta charset=utf-8><title>logic tests</title>\n"
        "<script>\nwindow.loadError = null;\ntry {\n"
        + "\n;\n".join(src)
        + "\n} catch (e) { window.loadError = String(e && e.stack || e); }\n</script>"
    )
    # Inside the repo, not /tmp: the snap-confined browser can read $HOME.
    path = os.path.join(ROOT, 'test', '.harness.html')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(page)
    return 'file://' + path


def _strip_comments(text, marker):
    """Drop line comments so prose in them cannot look like a payload key."""
    out = []
    for line in text.splitlines():
        i = line.find(marker)
        out.append(line if i < 0 else line[:i])
    return "\n".join(out)


def _between(text, start, end):
    i = text.index(start)
    return text[i + len(start):text.index(end, i + len(start))]


def _probe_constants(raw_src):
    """Top-level literal constants of tools/probe.py, read rather than imported.

    Importing it was the obvious way and it is wrong twice: exec_module goes
    through the bytecode cache, so an edit landing in the same second as its
    .pyc is read straight past - the check then validates a probe that is no
    longer on disk - and running the logic suite should not execute a file
    whose whole purpose is to bill the API.
    """
    import ast
    consts = {}
    for node in ast.parse(raw_src).body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)):
            try:
                consts[node.targets[0].id] = ast.literal_eval(node.value)
            except ValueError:
                pass   # not a literal (a call, an f-string) - nothing to compare
    return consts


def check_probe_drift():
    """tools/probe.py restates the two request payloads so it can run standalone
    and stdlib-only. Everything it restates is compared here. A probe that sends
    what production no longer sends proves nothing about production - and the
    drift is invisible, because both files keep working on their own.

    Compared: schema field names, enum values, required lists and
    additionalProperties; the mirrored Config.gs constants; and each payload's
    top-level keys, max_tokens and server-tool parameters. Prompt text is
    deliberately not compared - wording is the one thing the API does not care
    about the shape of, and pinning it here would make every reword a test fix.
    """
    import re
    gs = _strip_comments(
        open(os.path.join(SRC, 'Claude.gs'), encoding='utf-8').read(), '//')
    cfg = _strip_comments(
        open(os.path.join(SRC, 'Config.gs'), encoding='utf-8').read(), '//')
    raw_py = open(os.path.join(ROOT, 'tools', 'probe.py'), encoding='utf-8').read()
    # Comments stripped for the text scans below; ast gets the raw source, since
    # stripping on '#' would cut into any string literal containing one.
    py_src = _strip_comments(raw_py, '#')
    probe = _probe_constants(raw_py)

    fails = []

    def compare(label, expected, actual):
        if expected == actual:
            print(f"  PASS  probe {label}")
            return
        fails.append(label)
        print(f"  FAIL  probe {label} has drifted from src/")
        if isinstance(expected, set):
            print(f"        only in src/:      {sorted(expected - actual)}")
            print(f"        only in probe.py:  {sorted(actual - expected)}")
        else:
            print(f"        src/:      {expected!r}")
            print(f"        probe.py:  {actual!r}")

    def cfg_str(name):
        return re.search(r"^  %s: '([^']*)'" % name, cfg, re.M).group(1)

    def cfg_num(name):
        return float(re.search(r"^  %s: ([\d.]+)" % name, cfg, re.M).group(1))

    # 1. The two schemas: field names.
    gs_triage = _between(gs, 'function triageSchema_', '/** Classify one email')
    py_triage = _between(py_src, 'TRIAGE_SCHEMA = {', 'COMPANY_TOOL = {')
    compare('triage schema fields',
            set(re.findall(r'^    (\w+): \{', gs_triage, re.M)),
            set(re.findall(r'^        "(\w+)": \{', py_triage, re.M)))

    gs_tool = _between(gs, 'function companyTool_', 'var ENRICH_SYSTEM')
    py_tool = _between(py_src, 'COMPANY_TOOL = {', 'def call(')
    compare('company tool fields',
            set(re.findall(r'^      (\w+): \{', gs_tool, re.M)),
            set(re.findall(r'^            "(\w+)": \{', py_tool, re.M)))
    compare('company tool strict flag',
            'strict: true' in gs_tool, '"strict": True' in py_tool)

    # 1b. Enum values and the two strict-mode guarantees. Field names can match
    #     while an enum is empty or an additionalProperties is missing - and an
    #     enum silently dropped by JSON.stringify is the failure CLAUDE.md
    #     records this project shipping once.
    def gs_array(name):
        return re.findall(r"'([^']*)'", _between(cfg, 'var %s = [' % name, '];'))

    def gs_enum(block, field):
        m = re.search(r"%s: \{[^}]*enum: \[([^\]]*)\]" % field, block, re.S)
        return set(re.findall(r"'([^']*)'", m.group(1))) if m else set()

    def gs_required(block):
        return set(re.findall(r"'([^']*)'", _between(block, 'required: [', ']')))

    triage_schema = probe.get('TRIAGE_SCHEMA') or {}
    company_tool = probe.get('COMPANY_TOOL') or {}
    company_schema = company_tool.get('input_schema', {})

    compare('category enum', set(gs_array('CATEGORIES')),
            set(triage_schema.get('properties', {}).get('category', {}).get('enum', [])))
    compare('market enum', set(gs_array('MARKETS')),
            set(company_schema.get('properties', {}).get('market', {}).get('enum', [])))
    for field in ('stage_hint', 'confidence'):
        compare(f'{field} enum', gs_enum(gs_triage, field),
                set(triage_schema.get('properties', {}).get(field, {}).get('enum', [])))

    compare('triage required', gs_required(gs_triage),
            set(triage_schema.get('required', [])))
    compare('company required', gs_required(gs_tool),
            set(company_schema.get('required', [])))
    compare('triage additionalProperties',
            'additionalProperties: false' in gs_triage,
            triage_schema.get('additionalProperties') is False)
    compare('company additionalProperties',
            'additionalProperties: false' in gs_tool,
            company_schema.get('additionalProperties') is False)

    # 2. Mirrored Config.gs values. The probe cannot read Config.gs without
    #    growing a parser, so it restates them and they are checked here.
    for name, kind in (('API_VERSION', cfg_str), ('TRIAGE_MODEL', cfg_str),
                       ('ENRICH_MODEL', cfg_str), ('ENRICH_MAX_SEARCHES', cfg_num),
                       ('ENRICH_MAX_FETCHES', cfg_num),
                       ('ENRICH_MAX_FETCH_TOKENS', cfg_num),
                       ('PRICE_PER_SEARCH', cfg_num)):
        expected = kind(name)
        actual = probe.get(name)
        compare(name, expected,
                type(expected)(actual) if actual is not None else None)

    gs_prices = dict((m, {'input': float(i), 'output': float(o)}) for m, i, o in
                     re.findall(r"'([\w.-]+)': \{ input: ([\d.]+), output: ([\d.]+) \}", cfg))
    compare('PRICE_PER_MTOK', gs_prices,
            dict((m, {'input': float(v['input']), 'output': float(v['output'])})
                 for m, v in (probe.get('PRICE_PER_MTOK') or {}).items()))

    # 3. The two payloads: top-level keys, max_tokens, and the server tools.
    #    The server-tool key sets are what catch a dropped max_content_tokens -
    #    a difference the API accepts silently and only the bill reports.
    gs_calls = {
        'triage': _between(gs, 'function triageMessage_', 'if (res.stop_reason'),
        'enrich': _between(gs, 'function enrichCompany_', 'function firstOfType_'),
    }
    py_calls = {
        'triage': _between(py_src, 'def probe_triage(', 'def probe_enrich('),
        'enrich': py_src[py_src.index('def probe_enrich('):],
    }
    for which in ('triage', 'enrich'):
        compare(f'{which} payload keys',
                set(re.findall(r'^    (\w+):', gs_calls[which], re.M)),
                set(re.findall(r'^        "(\w+)":', py_calls[which], re.M)))

    compare('triage max_tokens',
            int(re.search(r'max_tokens: (\d+)', gs_calls['triage']).group(1)),
            probe.get('TRIAGE_MAX_TOKENS'))
    compare('enrich max_tokens',
            int(re.search(r'max_tokens: (\d+)', gs_calls['enrich']).group(1)),
            probe.get('ENRICH_MAX_TOKENS'))

    gs_types = re.findall(r"type: '(web_\w+?_\d{8})'", gs_calls['enrich'])
    compare('server tool types', gs_types,
            [probe.get('WEB_SEARCH_TYPE'), probe.get('WEB_FETCH_TYPE')])

    # Each tool's parameters are whatever sits between its type and the next
    # tool in the list. Skipped when the types themselves disagree - that
    # comparison has already reported, and the slice points would be wrong.
    if len(gs_types) == 2:
        for tool, gs_from, gs_to, py_from, py_to in (
                ('web_search', gs_types[0], gs_types[1],
                 'WEB_SEARCH_TYPE', 'WEB_FETCH_TYPE'),
                ('web_fetch', gs_types[1], 'companyTool_()',
                 'WEB_FETCH_TYPE', 'COMPANY_TOOL')):
            gs_seg = _between(gs_calls['enrich'], gs_from, gs_to)
            py_seg = _between(py_calls['enrich'], py_from, py_to)
            compare(f'{tool} tool params',
                    set(re.findall(r'(\w+):', gs_seg)) - {'CONFIG'},
                    set(re.findall(r'"(\w+)":', py_seg)))

    return not fails


def main():
    # geckodriver runs under snap confinement, which refuses this process's
    # SIGTERM. Selenium catches the resulting PermissionError, logs the whole
    # traceback and carries on (service.py: "does not raise itself ... but
    # ignores errors here") - so it prints after every test has already run and
    # passed, once at driver.quit() and once at exit. It made a green run look
    # like a failed one, which is worse than the leaked process it reports.
    logging.getLogger('selenium.webdriver.common.service').setLevel(logging.CRITICAL)

    opts = Options()
    opts.add_argument('-headless')
    # /usr/bin/firefox is a snap wrapper script, not an executable geckodriver
    # can launch; point at the real binary inside the snap.
    for candidate in ('/snap/firefox/current/usr/lib/firefox/firefox',
                      '/usr/lib/firefox/firefox', '/usr/bin/firefox-esr'):
        if os.path.exists(candidate):
            opts.binary_location = candidate
            break
    driver = webdriver.Firefox(options=opts)
    try:
        url = build_page()
        driver.get(url)
        load_error = driver.execute_script("return window.loadError;")
        if load_error:
            sys.exit("source threw while loading:\n" + load_error)
        results = driver.execute_script("return window.results || null;")
    finally:
        driver.quit()

    if results is None:
        sys.exit("no results - a source file threw while loading")

    failed = [r for r in results if not r['pass']]
    drift_ok = check_probe_drift()
    for r in results:
        print(("  PASS  " if r['pass'] else "  FAIL  ") + r['name'])
        if not r['pass']:
            print("        " + r['err'])
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if (failed or not drift_ok) else 0)

if __name__ == '__main__':
    main()
