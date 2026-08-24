"""Build deterministic CortexLume planner assets on the locked Cedalion 25k mesh."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
from xml.etree import ElementTree

import nibabel as nib
import numpy as np
import trimesh


def labels_from_xml(path: Path, channels: int) -> np.ndarray:
    labels = np.full(channels, "", dtype="U80")
    for element in ElementTree.parse(path).findall(".//label"):
        labels[int(element.attrib["index"])] = (element.text or "").strip()
    if np.any(labels == ""):
        raise ValueError("Harvard-Oxford cortical labels are incomplete")
    return labels


def load_vertices(path: Path) -> np.ndarray:
    values: list[tuple[float, float, float]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        for expected, row in enumerate(csv.DictReader(stream)):
            if int(row["vertex"]) != expected:
                raise ValueError("Cedalion vertex coordinate order is invalid")
            values.append((float(row["mni152_r"]), float(row["mni152_a"]), float(row["mni152_s"])))
    result = np.asarray(values, dtype=np.float64)
    if result.shape != (25_000, 3) or not np.all(np.isfinite(result)):
        raise ValueError("Cedalion vertex coordinate table is invalid")
    return result


def build_vertex_areas(mesh_path: Path, destination: Path) -> None:
    mesh = trimesh.load(mesh_path, force="mesh", process=False)
    if not isinstance(mesh, trimesh.Trimesh) or mesh.vertices.shape != (25_000, 3):
        raise ValueError("Cedalion scientific mesh is not the locked 25k surface")
    areas = np.zeros(25_000, dtype=np.float64)
    triangle_share = np.asarray(mesh.area_faces, dtype=np.float64) / 3.0
    for corner in range(3):
        np.add.at(areas, mesh.faces[:, corner], triangle_share)
    if np.any(~np.isfinite(areas)) or np.any(areas <= 0):
        raise ValueError("Computed vertex areas are invalid")
    areas.astype("<f4").tofile(destination)


def build_surface_atlas(root: Path, vertices: np.ndarray, destination: Path) -> None:
    atlas_path = root / "upstream/fsl/data/atlases/HarvardOxford/HarvardOxford-cortl-prob-1mm.nii.gz"
    labels_path = root / "upstream/fsl/data/atlases/HarvardOxford-Cortical-Lateralized.xml"
    image = nib.load(atlas_path)
    if image.shape[:3] != (182, 218, 182) or len(image.shape) != 4:
        raise ValueError(f"Unexpected Harvard-Oxford shape: {image.shape}")
    labels = labels_from_xml(labels_path, image.shape[3])
    ras_voxels = np.rint(vertices - np.array([-91.0, -126.0, -72.0])).astype(np.int64)
    inside = np.all((ras_voxels >= 0) & (ras_voxels < np.array(image.shape[:3])), axis=1)
    source_voxels = ras_voxels.copy()
    source_voxels[:, 0] = 181 - source_voxels[:, 0]
    memberships = np.zeros((25_000, image.shape[3]), dtype=np.uint8)
    selected = source_voxels[inside]
    coordinates = tuple(selected[:, axis] for axis in range(3))
    for channel in range(image.shape[3]):
        volume = np.rint(np.asanyarray(image.dataobj[..., channel])).clip(0, 100).astype(np.uint8)
        memberships[inside, channel] = volume[coordinates]
    if int(memberships.max()) != 100 or not np.count_nonzero(memberships):
        raise ValueError("Surface Harvard-Oxford membership asset is empty")
    np.savez_compressed(destination, memberships=memberships, labels=labels)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-root", type=Path, default=Path("assets/templates/MNI152NLin6Asym"))
    args = parser.parse_args()
    root = args.asset_root.resolve()
    generated = root / "generated"
    vertices = load_vertices(generated / "brain_vertex_coordinates.csv")
    area_path = generated / "brain_vertex_areas_f32.bin"
    atlas_path = generated / "harvard_oxford_cortical_surface_25k.npz"
    build_vertex_areas(generated / "brain_scientific.glb", area_path)
    build_surface_atlas(root, vertices, atlas_path)
    metadata = {
        "format": "cortexlume-planner-surface-assets",
        "formatVersion": 1,
        "surface": "Cedalion-ICBM152-25k",
        "coordinateConvention": "RAS+",
        "vertexArea": {"file": area_path.name, "dtype": "float32-le", "units": "mm2", "sha256": sha256(area_path)},
        "corticalAtlas": {"file": atlas_path.name, "probabilityUnit": "percent", "sha256": sha256(atlas_path)},
    }
    (generated / "planner_surface_assets.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
