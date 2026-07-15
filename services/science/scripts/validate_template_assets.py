from __future__ import annotations

import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortexlume_science.template_gate import inspect_template_gate, template_directory  # noqa: E402


EXPECTED_SHAPE = (182, 218, 182)
EXPECTED_VOXELS = (1.0, 1.0, 1.0)


def main() -> int:
    gate = inspect_template_gate()
    manifest = gate.manifest
    issues = list(gate.issues)
    for relative in manifest.get("niftiFiles", []):
        path = template_directory() / relative
        if not path.exists():
            continue
        image = nib.load(path)
        if image.shape[:3] != EXPECTED_SHAPE:
            issues.append(f"unexpected_nifti_shape:{relative}:{image.shape[:3]}")
        if not np.allclose(image.header.get_zooms()[:3], EXPECTED_VOXELS):
            issues.append(f"unexpected_voxel_size:{relative}:{image.header.get_zooms()[:3]}")
        if not np.isfinite(image.affine).all():
            issues.append(f"non_finite_affine:{relative}")
    print(json.dumps({"passed": not issues, "issues": issues}, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
