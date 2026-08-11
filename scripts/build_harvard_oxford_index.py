"""Build CortexLume's compact, exact-voxel Harvard-Oxford lookup index.

The FSL probability volumes are the upstream authority.  We flip their first
axis into TemplateFlow's positive-diagonal RAS+ grid, retain the three largest
unmodified integer probabilities at every 1 mm voxel, and write a compressed
NumPy archive for the packaged science service.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from xml.etree import ElementTree

import nibabel as nib
import numpy as np


TARGET_AFFINE = np.array([
    [1.0, 0.0, 0.0, -91.0],
    [0.0, 1.0, 0.0, -126.0],
    [0.0, 0.0, 1.0, -72.0],
    [0.0, 0.0, 0.0, 1.0],
])
SOURCE_AFFINE = np.array([
    [-1.0, 0.0, 0.0, 90.0],
    [0.0, 1.0, 0.0, -126.0],
    [0.0, 0.0, 1.0, -72.0],
    [0.0, 0.0, 0.0, 1.0],
])


def labels_from_xml(path: Path, channels: int) -> np.ndarray:
    labels = np.full(channels, "", dtype="U80")
    for element in ElementTree.parse(path).findall(".//label"):
        index = int(element.attrib["index"])
        if not 0 <= index < channels:
            raise ValueError(f"Label index {index} is outside 0..{channels - 1}")
        labels[index] = (element.text or "").strip().replace("Ventrical", "Ventricle")
    if np.any(labels == ""):
        missing = np.flatnonzero(labels == "").tolist()
        raise ValueError(f"Missing labels for channels: {missing}")
    return labels


def top_three(
    path: Path,
    xml_path: Path,
    excluded_channels: frozenset[int] = frozenset(),
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    image = nib.load(path)
    if image.shape[:3] != (182, 218, 182) or len(image.shape) != 4:
        raise ValueError(f"Unexpected atlas shape: {image.shape}")
    if not np.allclose(image.affine, SOURCE_AFFINE, atol=1e-6):
        raise ValueError(f"Unexpected FSL affine:\n{image.affine}")

    channels = image.shape[3]
    labels = labels_from_xml(xml_path, channels)
    probabilities = np.zeros((*image.shape[:3], 3), dtype=np.uint8)
    indices = np.full((*image.shape[:3], 3), 255, dtype=np.uint8)

    for channel in range(channels):
        if channel in excluded_channels:
            continue
        values = np.rint(np.asanyarray(image.dataobj[..., channel])).clip(0, 100).astype(np.uint8)
        first = values > probabilities[..., 0]
        probabilities[..., 2][first] = probabilities[..., 1][first]
        indices[..., 2][first] = indices[..., 1][first]
        probabilities[..., 1][first] = probabilities[..., 0][first]
        indices[..., 1][first] = indices[..., 0][first]
        probabilities[..., 0][first] = values[first]
        indices[..., 0][first] = channel

        second = (~first) & (values > probabilities[..., 1])
        probabilities[..., 2][second] = probabilities[..., 1][second]
        indices[..., 2][second] = indices[..., 1][second]
        probabilities[..., 1][second] = values[second]
        indices[..., 1][second] = channel

        third = (~first) & (~second) & (values > probabilities[..., 2])
        probabilities[..., 2][third] = values[third]
        indices[..., 2][third] = channel

    if int(probabilities.max()) != 100 or not np.count_nonzero(probabilities):
        raise ValueError(f"Atlas is empty or incorrectly scaled: max={probabilities.max()}")
    return indices[::-1].copy(), probabilities[::-1].copy(), labels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-root", type=Path, default=Path("assets/templates/MNI152NLin6Asym"))
    args = parser.parse_args()
    root = args.asset_root.resolve()
    fsl = root / "upstream" / "fsl" / "data" / "atlases"
    cortical_i, cortical_p, cortical_labels = top_three(
        fsl / "HarvardOxford" / "HarvardOxford-cortl-prob-1mm.nii.gz",
        fsl / "HarvardOxford-Cortical-Lateralized.xml",
    )
    deep_i, deep_p, deep_labels = top_three(
        fsl / "HarvardOxford" / "HarvardOxford-sub-prob-1mm.nii.gz",
        fsl / "HarvardOxford-Subcortical.xml",
        frozenset({0, 1, 11, 12}),
    )
    generated = root / "generated"
    generated.mkdir(parents=True, exist_ok=True)
    destination = generated / "harvard_oxford_top3_1mm.npz"
    np.savez_compressed(
        destination,
        affine=TARGET_AFFINE,
        cortical_indices=cortical_i,
        cortical_probabilities=cortical_p,
        cortical_labels=cortical_labels,
        subcortical_indices=deep_i,
        subcortical_probabilities=deep_p,
        subcortical_labels=deep_labels,
    )
    metadata = {
        "format": "cortexlume-harvard-oxford-top3",
        "formatVersion": 1,
        "space": "MNI152NLin6Asym",
        "coordinateConvention": "RAS+",
        "resolutionMm": 1,
        "sampling": "nearest_voxel",
        "probabilityUnit": "percent",
        "topK": 3,
        "subcorticalExcludedChannels": {
            "0": "Left Cerebral White Matter",
            "1": "Left Cerebral Cortex",
            "11": "Right Cerebral White Matter",
            "12": "Right Cerebral Cortex"
        },
        "templateFlowCommit": "c906e8d808a34719e5024a4bde61f03a4e411ddd",
        "atlasSource": "FSL Harvard-Oxford data package distributed through NITRC (download 9902)",
        "note": "FSL arrays were x-flipped without interpolation into TemplateFlow's positive-diagonal RAS+ grid.",
    }
    (generated / "harvard_oxford_top3_1mm.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )
    print(destination)


if __name__ == "__main__":
    main()
