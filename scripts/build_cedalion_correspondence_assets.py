"""Build renderer and correspondence assets without destroying vertex identity."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import nibabel as nib
import numpy as np
import trimesh


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cedalion-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--renderer-dir", type=Path, required=True)
    args = parser.parse_args()

    source = args.cedalion_dir.resolve()
    output = args.output_dir.resolve()
    renderer = args.renderer_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    renderer.mkdir(parents=True, exist_ok=True)

    mesh = trimesh.load(source / "mask_brain.obj", force="mesh", process=False)
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.vertices) != 25_000:
        raise ValueError("Cedalion canonical brain mesh must contain exactly 25,000 vertices")
    affine = nib.load(source / "mask_gray.nii").affine
    ras = nib.affines.apply_affine(affine, np.asarray(mesh.vertices))
    mesh.vertices = np.column_stack((ras[:, 0], ras[:, 2], -ras[:, 1]))

    scientific_glb = output / "brain_scientific.glb"
    scientific_glb.write_bytes(mesh.export(file_type="glb"))
    shutil.copy2(scientific_glb, renderer / scientific_glb.name)

    copied = {}
    for name in ("brain_vertex_coordinates.csv", "voxel_to_vertex_brain.mtx.gz"):
        destination = output / name
        shutil.copy2(source / name, destination)
        copied[name] = {"path": destination.name, "sha256": sha256(destination)}

    record = {
        "format": "cortexlume-cedalion-correspondence-assets",
        "formatVersion": 1,
        "canonicalMesh": {
            "path": scientific_glb.name,
            "sha256": sha256(scientific_glb),
            "vertices": int(len(mesh.vertices)),
            "faces": int(len(mesh.faces)),
            "coordinateConvention": "Three [R,S,-A] mm",
            "simplified": False,
        },
        "correspondence": copied,
    }
    manifest = output / "cedalion-correspondence-assets.json"
    manifest.write_text(f"{json.dumps(record, indent=2)}\n", encoding="utf-8")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
