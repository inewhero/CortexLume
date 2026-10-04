"""Shared analytical fixtures also exercised by the TypeScript evaluator."""
import json
from pathlib import Path

import numpy as np

from cortexlume_science.anatomical_coverage import _adaptive_channel_kernel
from cortexlume_science.models import ChannelSensitivityKernel


def test_shared_adaptive_kernel_parity_fixture():
    fixture = json.loads((Path(__file__).parent / "fixtures/adaptive_kernel_parity.json").read_text())
    kernel = ChannelSensitivityKernel.model_validate(fixture["kernel"])
    points = np.asarray([case["point"] for case in fixture["cases"]], dtype=np.float64)
    expected = np.asarray([case["weight"] for case in fixture["cases"]], dtype=np.float64)
    np.testing.assert_allclose(_adaptive_channel_kernel(points, kernel), expected, rtol=1e-12, atol=1e-14)
