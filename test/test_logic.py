"""pytest front end for the logic suite, so `test/` works as a test target.

Every JS case comes out of a single browser run, so that run happens once here
at import - which is collection time - and each case becomes its own pytest
node. Asserting on the whole list in one test would report a single red line
without saying which case broke.

`run_tests.py` is still the CLI entry point and does not import this file.
"""
import pytest

from run_tests import check_probe_schema_drift, run_logic_tests

_RESULTS = run_logic_tests()


@pytest.mark.parametrize('result', _RESULTS, ids=[r['name'] for r in _RESULTS])
def test_logic(result):
    assert result['pass'], result['err']


def test_probe_schema_matches_claude_gs():
    ok, detail = check_probe_schema_drift()
    assert ok, detail
