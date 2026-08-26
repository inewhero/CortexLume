from __future__ import annotations

import argparse
import gzip
import json
import struct
import sys
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "science"))

from cortexlume_science.target_map_import import (  # noqa: E402
    FSL_2MM_AFFINE,
    FSL_2MM_SHAPE,
    process_target_map_import,
)


def build_visual_target() -> bytes:
    """Create a deterministic bilateral occipital z-statistic example."""
    x = np.arange(FSL_2MM_SHAPE[0], dtype=np.float32) * 2.0 - 90.0
    y = np.arange(FSL_2MM_SHAPE[1], dtype=np.float32) * 2.0 - 126.0
    z = np.arange(FSL_2MM_SHAPE[2], dtype=np.float32) * 2.0 - 72.0
    xx, yy, zz = np.meshgrid(x, y, z, indexing="ij", sparse=True)
    values = np.zeros(FSL_2MM_SHAPE, dtype=np.float32)
    for peak_x, amplitude in ((-18.0, 7.2), (18.0, 6.8)):
        squared = (
            ((xx - peak_x) / 13.0) ** 2
            + ((yy + 92.0) / 15.0) ** 2
            + ((zz - 5.0) / 12.0) ** 2
        )
        values += amplitude * np.exp(-0.5 * squared).astype(np.float32)
    values[values < 0.35] = 0

    header = bytearray(352)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, *FSL_2MM_SHAPE, 1, 1, 1, 1)
    struct.pack_into("<h", header, 68, 0)  # continuous statistic
    struct.pack_into("<h", header, 70, 16)  # float32
    struct.pack_into("<h", header, 72, 32)
    struct.pack_into("<8f", header, 76, 1.0, 2.0, 2.0, 2.0, 1.0, 1.0, 1.0, 1.0)
    struct.pack_into("<f", header, 108, 352.0)
    header[123] = 2  # millimetres
    description = b"CortexLume bilateral visual target z map"
    header[148 : 148 + len(description)] = description
    struct.pack_into("<h", header, 254, 4)  # sform MNI
    for row in range(3):
        struct.pack_into("<4f", header, 280 + row * 16, *FSL_2MM_AFFINE[row])
    header[344:348] = b"n+1\0"
    payload = bytes(header) + values.astype("<f4").tobytes(order="F")
    return gzip.compress(payload, compresslevel=9, mtime=0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--nifti", type=Path, required=True)
    parser.add_argument("--map-json", type=Path, required=True)
    args = parser.parse_args()

    raw = build_visual_target()
    result = process_target_map_import(
        raw,
        args.nifti.name,
        "NeurosynthMNI152-2mm",
    )
    if not result["accepted"] or result["map"] is None:
        raise SystemExit(f"Generated NIfTI did not pass CortexLume validation: {result['diagnostics']}")

    result["map"]["target"].update(
        {
            "id": "example:bilateral-visual-target",
            "label": "Bilateral visual target",
            "aliases": ["visual", "vision", "occipital"],
            "domain": "Perception",
            "subdomain": "Vision",
            "description": "Synthetic bilateral occipital z-statistic map for the CortexLume import tutorial.",
            "peakRegions": ["Left Occipital Cortex", "Right Occipital Cortex"],
        }
    )
    args.nifti.parent.mkdir(parents=True, exist_ok=True)
    args.map_json.parent.mkdir(parents=True, exist_ok=True)
    args.nifti.write_bytes(raw)
    args.map_json.write_text(json.dumps(result["map"], ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
