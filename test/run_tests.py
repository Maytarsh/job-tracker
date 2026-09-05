#!/usr/bin/env python3
"""Run test/logic_tests.js against the .gs sources in headless Firefox.

Apps Script has no local runtime, so this loads the source files into a real JS
engine with the Google services stubbed out. Covers pure logic only - anything
touching Gmail, Sheets or the API is exercised in the Apps Script editor instead.
"""
import glob, json, os, sys
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

STUBS = """
var Logger = { log: function () {} };
var Utilities = { sleep: function () {} };
var PropertiesService = {
  getScriptProperties: function () {
    return { getProperty: function () { return 'stub-key'; }, setProperty: function () {} };
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


def check_probe_schema_drift():
    """tools/probe.py restates the triage schema so it can run standalone.
    If it drifts from src/Claude.gs the probe stops validating the real thing."""
    import re
    gs = open(os.path.join(SRC, 'Claude.gs'), encoding='utf-8').read()
    py = open(os.path.join(ROOT, 'tools', 'probe.py'), encoding='utf-8').read()
    gs_block = gs[gs.index('function triageSchema_'):gs.index('/** Classify one email')]
    py_block = py[py.index('TRIAGE_SCHEMA = {'):py.index('COMPANY_TOOL = {')]
    gs_fields = set(re.findall(r'^    (\w+): \{', gs_block, re.M))
    py_fields = set(re.findall(r'^        "(\w+)": \{', py_block, re.M))
    if gs_fields != py_fields:
        print("  FAIL  probe.py triage schema has drifted from Claude.gs")
        print(f"        only in Claude.gs: {sorted(gs_fields - py_fields)}")
        print(f"        only in probe.py:  {sorted(py_fields - gs_fields)}")
        return False
    print(f"  PASS  probe.py schema matches Claude.gs ({len(gs_fields)} fields)")
    return True


def main():
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
    drift_ok = check_probe_schema_drift()
    for r in results:
        print(("  PASS  " if r['pass'] else "  FAIL  ") + r['name'])
        if not r['pass']:
            print("        " + r['err'])
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if (failed or not drift_ok) else 0)

if __name__ == '__main__':
    main()
