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
import manifold3d as manifold
from skimage import measure
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree


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
    # Aggressive decimation created non-manifold edges and tiny detached shells.
    # A closed source must stay closed; prefer its original topology over a
    # smaller but broken display mesh.
    reduced = mesh.simplify_quadric_decimation(face_count=target_faces, aggression=3)
    if mesh.is_watertight and not reduced.is_watertight:
        return mesh
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


def export_correspondence_assets(source: Path, output: Path) -> dict[str, object]:
    """Export Cedalion's canonical surface without changing vertex identity."""
    mesh = trimesh.load(source / "mask_brain.obj", force="mesh", process=False)
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.vertices) != 25_000:
        raise ValueError("Cedalion canonical brain mesh must contain exactly 25,000 vertices")
    affine = nib.load(source / "mask_gray.nii").affine
    ras = nib.affines.apply_affine(affine, np.asarray(mesh.vertices))
    mesh.vertices = to_three(ras)
    scientific_glb = output / "brain_scientific.glb"
    scientific_glb.write_bytes(mesh.export(file_type="glb"))

    correspondence: dict[str, dict[str, str]] = {}
    for name in ("brain_vertex_coordinates.csv", "voxel_to_vertex_brain.mtx.gz"):
        destination = output / name
        shutil.copy2(source / name, destination)
        correspondence[name] = {"file": name, "sha256": sha256(destination)}

    return {
        "canonicalMesh": {
            "file": scientific_glb.name,
            "sha256": sha256(scientific_glb),
            "vertices": int(len(mesh.vertices)),
            "faces": int(len(mesh.faces)),
            "simplified": False,
        },
        "correspondence": correspondence,
    }


def mesh_from_mask(path: Path) -> trimesh.Trimesh:
    image = nib.load(path)
    volume = np.asarray(image.dataobj) > 0
    # Cedalion's white-matter mask also contains a narrow inferior brain-stem
    # continuation. Keep the cranial structure for a legible nested surface.
    inferior_cutoff = int(np.ceil((-65.0 - image.affine[2, 3]) / image.affine[2, 2]))
    volume[:, :, :inferior_cutoff] = False
    vertices, faces, _normals, _values = measure.marching_cubes(gaussian_filter(volume.astype(np.float32), 0.65), 0.5, allow_degenerate=False)
    vertices_ras = nib.affines.apply_affine(image.affine, vertices)
    mesh = trimesh.Trimesh(vertices=vertices_ras, faces=faces, process=True)
    mesh.invert()  # marching_cubes descent ordering points into the binary mask.
    mesh.remove_unreferenced_vertices()
    return mesh


def nest_display_white_matter(
    gray: trimesh.Trimesh, white: trimesh.Trimesh,
    clearance_mm: float = 0.35, local_reach_mm: float = 3.5,
) -> tuple[trimesh.Trimesh, dict[str, object]]:
    """Close local display intersections without opening holes in the WM mesh.

    The cerebral pial mesh does not enclose cerebellum or brainstem. Preserve
    exterior components that extend beyond the local cortical boundary zone.
    Only the display surface changes; scientific correspondence is separate.
    """
    def solid(mesh: trimesh.Trimesh) -> manifold.Manifold:
        result = manifold.Manifold(manifold.Mesh(
            np.asarray(mesh.vertices, dtype=np.float32),
            np.asarray(mesh.faces, dtype=np.uint32),
        ))
        if result.status() != manifold.Error.NoError:
            raise ValueError(f"Invalid display solid: {result.status()}")
        return result

    inner = gray.copy()
    inner.vertices -= inner.vertex_normals * clearance_mm
    # Intersect with the unmodified pial solid: normal offsets at sharp sulci
    # must never expand the admissible WM volume outside the original pial.
    envelope = solid(inner) ^ solid(gray)
    original = solid(white)
    exterior = (original - envelope).decompose()
    pial_vertices = cKDTree(np.asarray(gray.vertices))
    removed_parts = []
    removed_volume = 0.0
    local_parts = 0
    retained_parts = 0
    for part in exterior:
        vertices = np.asarray(part.to_mesh().vert_properties)[:, :3]
        maximum_distance = float(pial_vertices.query(vertices)[0].max())
        if maximum_distance > local_reach_mm and part.volume() >= 1.0:
            retained_parts += 1
            continue
        removed_parts.append(part)
        removed_volume += part.volume()
        local_parts += 1
    fraction = removed_volume / original.volume()
    if fraction > 0.01:
        raise ValueError(f"Display repair would remove too much white matter: {fraction:.2%}")
    # Recompose the selected disconnected boundaries before subtraction. This
    # preserves the orientation of any cavity boundaries in the difference.
    result = original - manifold.Manifold.compose(removed_parts) if removed_parts else original
    # Boolean boundaries can contain sub-pixel sliver triangles. Remove them
    # with a bounded 0.02 mm simplification while preserving closed topology.
    result = result.simplify(0.02)
    output = result.to_mesh()
    corrected = trimesh.Trimesh(output.vert_properties[:, :3], output.tri_verts, process=False)
    if removed_parts:
        # Smooth only the local repair zone, with a strict 0.1 mm displacement
        # limit. This regularizes very thin boundary triangles without moving
        # distant anatomy or consuming the 0.35 mm nesting clearance.
        smoothed = corrected.copy()
        trimesh.smoothing.filter_taubin(smoothed, lamb=0.5, nu=0.53, iterations=6)
        delta = smoothed.vertices - corrected.vertices
        length = np.linalg.norm(delta, axis=1)
        delta *= np.minimum(1.0, 0.1 / np.maximum(length, 1e-12))[:, None]
        local = pial_vertices.query(corrected.vertices)[0] <= local_reach_mm
        corrected.vertices[local] += delta[local]
    if not corrected.is_watertight or not corrected.is_winding_consistent:
        raise ValueError("Display repair must produce a closed oriented WM surface")
    if np.any(corrected.area_faces <= 1e-12):
        raise ValueError("Display repair produced degenerate faces")
    return corrected, {
        "method": "closed-solid local intersection repair",
        "clearanceMm": clearance_mm,
        "localReachMm": local_reach_mm,
        "boundarySimplificationMm": 0.02,
        "boundarySmoothingLimitMm": 0.1,
        "repairedLocalComponents": local_parts,
        "preservedNonCorticalComponents": retained_parts,
        "removedVolumeMm3": removed_volume,
        "retainedVolumeFraction": 1.0 - fraction,
    }


def build(source: Path, output: Path, renderer: Path | None) -> None:
    output.mkdir(parents=True, exist_ok=True)
    voxel_to_ras = nib.load(source / "mask_gray.nii").affine

    records = {
        "scalp": export_mesh(load_mesh(source / "mask_scalp.obj"), output / "scalp.glb", 45_000, voxel_to_ras),
        "grayMatter": export_mesh(load_mesh(source / "cortex_pial_high.obj"), output / "gray_matter.glb", 150_000, voxel_to_ras),
        "whiteMatter": export_mesh(mesh_from_mask(source / "mask_white.nii"), output / "white_matter.glb", 90_000),
    }
    gray = trimesh.load(output / "gray_matter.glb", force="mesh", process=False)
    white = trimesh.load(output / "white_matter.glb", force="mesh", process=False)
    white, nesting = nest_display_white_matter(gray, white)
    (output / "white_matter.glb").write_bytes(white.export(file_type="glb"))
    records["whiteMatter"].update({
        "sha256": sha256(output / "white_matter.glb"),
        "vertices": int(len(white.vertices)),
        "faces": int(len(white.faces)),
        "boundsThreeMm": np.asarray(white.bounds).round(4).tolist(),
        "displayNesting": nesting,
    })
    scientific = export_correspondence_assets(source, output)

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
    landmarks_path.write_text(json.dumps({"coordinateConvention": "MNI/RAS+", "points": points}, indent=2), encoding="utf-8", newline="\n")

    manifest = {
        "id": "Cedalion-ICBM152-v26.5.1",
        "sourceUrl": SOURCE_URL,
        "sourceArchiveSha256": SOURCE_ARCHIVE_SHA256,
        "coordinateConvention": "MNI/RAS+ mm; GLB vertices transformed to Three [x,z,-y]",
        "meshes": records,
        "scientificProjection": scientific,
        "landmarks": {"file": landmarks_path.name, "sha256": sha256(landmarks_path), "count": len(points)},
    }
    manifest_path = output / "anatomy-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8", newline="\n")

    if renderer:
        renderer.mkdir(parents=True, exist_ok=True)
        renderer_files = {
            "scalp.glb",
            "gray_matter.glb",
            "white_matter.glb",
            "brain_scientific.glb",
            "landmarks.json",
            "anatomy-manifest.json",
        }
        for name in renderer_files:
            shutil.copy2(output / name, renderer / name)

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
