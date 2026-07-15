"""Build browser-ready anatomical meshes from Cedalion's ICBM152 head model.

The input directory is the extracted ``hm_icbm152`` folder from Cedalion
v26.5.1. Output GLBs use CortexLume's Three.js coordinate convention
``[x, z, -y]`` while landmarks retain both MNI/RAS+ and Three coordinates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import nibabel as nib
import numpy as np
import trimesh
from skimage import measure


SOURCE_ARCHIVE_SHA256 = "91bb99709b6ceadd41674acc0db6cf26d70dccb57e41797b474aa9ce6aeed3e8"
SOURCE_URL = "https://doc.ibs.tu-berlin.de/cedalion/datasets/26.5.1/hm_icbm152.zip"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def to_three(vertices: np.ndarray) -> np.ndarray:
    return np.column_stack((vertices[:, 0], vertices[:, 2], -vertices[:, 1]))


def load_mesh(path: Path) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="mesh", process=True)
    if not isinstance(loaded, trimesh.Trimesh):
        raise TypeError(f"Expected triangular mesh in {path}")
    return loaded


def simplify(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    if len(mesh.faces) <= target_faces:
        return mesh
    reduced = mesh.simplify_quadric_decimation(face_count=target_faces)
    reduced.remove_unreferenced_vertices()
    return reduced


def export_mesh(
    mesh: trimesh.Trimesh,
    target: Path,
    target_faces: int,
    voxel_to_ras: np.ndarray | None = None,
) -> dict[str, object]:
    mesh = simplify(mesh, target_faces)
    if voxel_to_ras is not None:
        mesh.vertices = nib.affines.apply_affine(voxel_to_ras, np.asarray(mesh.vertices))
    mesh.vertices = to_three(np.asarray(mesh.vertices))
    mesh.remove_unreferenced_vertices()
    target.write_bytes(mesh.export(file_type="glb"))
    return {
        "file": target.name,
        "sha256": sha256(target),
        "vertices": int(len(mesh.vertices)),
        "faces": int(len(mesh.faces)),
        "boundsThreeMm": np.asarray(mesh.bounds).round(4).tolist(),
    }


def mesh_from_mask(path: Path) -> trimesh.Trimesh:
    image = nib.load(path)
    volume = np.asarray(image.dataobj) > 0
    # Cedalion's white-matter mask also contains a narrow inferior brain-stem
    # continuation. Keep the cranial structure for a legible nested surface.
    inferior_cutoff = int(np.ceil((-65.0 - image.affine[2, 3]) / image.affine[2, 2]))
    volume[:, :, :inferior_cutoff] = False
    vertices, faces, _normals, _values = measure.marching_cubes(volume.astype(np.uint8), 0.5)
    vertices_ras = nib.affines.apply_affine(image.affine, vertices)
    mesh = trimesh.Trimesh(vertices=vertices_ras, faces=faces, process=True)
    mesh.remove_unreferenced_vertices()
    return mesh


def build(source: Path, output: Path, renderer: Path | None) -> None:
    output.mkdir(parents=True, exist_ok=True)
    voxel_to_ras = nib.load(source / "mask_gray.nii").affine

    records = {
        "scalp": export_mesh(load_mesh(source / "mask_scalp.obj"), output / "scalp.glb", 45_000, voxel_to_ras),
        "grayMatter": export_mesh(load_mesh(source / "cortex_pial_high.obj"), output / "gray_matter.glb", 150_000, voxel_to_ras),
        "whiteMatter": export_mesh(mesh_from_mask(source / "mask_white.nii"), output / "white_matter.glb", 90_000),
    }

    raw_landmarks = json.loads((source / "landmarks.mrk.json").read_text(encoding="utf-8"))
    points = []
    for point in raw_landmarks["markups"][0]["controlPoints"]:
        ras = [round(float(value), 4) for value in point["position"]]
        points.append({
            "label": point["label"],
            "rasMm": ras,
            "threeMm": [ras[0], ras[2], -ras[1]],
            "system": "five-point" if point["label"] in {"Nz", "Iz", "LPA", "RPA", "Cz"} else "10-10",
        })
    landmarks_path = output / "landmarks.json"
    landmarks_path.write_text(json.dumps({"coordinateConvention": "MNI/RAS+", "points": points}, indent=2), encoding="utf-8")

    manifest = {
        "id": "Cedalion-ICBM152-v26.5.1",
        "sourceUrl": SOURCE_URL,
        "sourceArchiveSha256": SOURCE_ARCHIVE_SHA256,
        "coordinateConvention": "MNI/RAS+ mm; GLB vertices transformed to Three [x,z,-y]",
        "meshes": records,
        "landmarks": {"file": landmarks_path.name, "sha256": sha256(landmarks_path), "count": len(points)},
    }
    manifest_path = output / "anatomy-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if renderer:
        renderer.mkdir(parents=True, exist_ok=True)
        for path in output.iterdir():
            if path.is_file():
                shutil.copy2(path, renderer / path.name)

    print(json.dumps(manifest, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--renderer-dir", type=Path)
    args = parser.parse_args()
    build(args.source_dir.resolve(), args.output_dir.resolve(), args.renderer_dir.resolve() if args.renderer_dir else None)


if __name__ == "__main__":
    main()
