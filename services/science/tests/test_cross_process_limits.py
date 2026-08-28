import json
from pathlib import Path

from cortexlume_science.coverage_limits import CROSS_PROCESS_LIMITS


def test_cross_process_limits_are_loaded_from_the_canonical_shared_asset() -> None:
    root = Path(__file__).resolve().parents[3]
    expected = json.loads(
        (root / "config" / "cross-process-limits.json").read_text(encoding="utf-8")
    )
    assert CROSS_PROCESS_LIMITS == expected
