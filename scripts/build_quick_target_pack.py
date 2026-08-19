"""Build CortexLume's deterministic, offline Neurosynth Quick Target pack.

The release path uses the official Neurosynth v0.7 database and NiMARE's
MKDAChi2 association analysis. NiMARE, nibabel, pandas, and scipy are build-time
dependencies only; the installed science service reads the resulting pack with
numpy alone.

The ``--fixture`` mode produces synthetic Gaussian fields for integration tests
and interaction development. It is deliberately marked ``test-fixture`` and
must never be shipped as the release Neurosynth pack.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

import numpy as np


NEUROSYNTH_REPOSITORY = "https://github.com/neurosynth/neurosynth-data"
NEUROSYNTH_COMMIT = "209c33cd009d0b069398a802198b41b9c488b9b7"
NEUROSYNTH_VERSION = "7"
NIMARE_VERSION = "0.20.0"
NIMARE_TAG_COMMIT = "a3f4ae6d1a799a643fe59c170195d94f0e37506a"
VERTEX_COUNT = 25_000
TERM_THRESHOLD = 0.001
FDR_ALPHA = 0.05
KERNEL_RADIUS_MM = 10
_SLUG_RE = re.compile(r"[^a-z0-9]+")
PROFILE_FORMAT = "cortexlume-quick-target-profile"
PROFILE_FORMAT_VERSION = 1
MAP_SIMILARITY_REVIEW_THRESHOLD = 0.95
SMALL_SURFACE_SUPPORT_THRESHOLD = 25


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def slug(term: str) -> str:
    value = _SLUG_RE.sub("-", term.casefold()).strip("-")
    if not value:
        raise ValueError(f"Cannot create an id for term {term!r}")
    return f"neurosynth:{value}"


def load_profile(path: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    profile = json.loads(path.read_text(encoding="utf-8"))
    if profile.get("format") != PROFILE_FORMAT or profile.get("formatVersion") != PROFILE_FORMAT_VERSION:
        raise ValueError("Unsupported Quick Target profile format")
    targets = profile.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ValueError("Quick Target profile must contain targets")
    by_term: dict[str, dict[str, Any]] = {}
    for item in targets:
        if not isinstance(item, dict):
            raise ValueError("Quick Target profile targets must be objects")
        term, domain, subdomain = item.get("term"), item.get("domain"), item.get("subdomain")
        aliases = item.get("aliases", [])
        if not all(isinstance(value, str) and value.strip() for value in (term, domain, subdomain)):
            raise ValueError("Profile term, domain, and subdomain must be nonempty strings")
        if term in by_term:
            raise ValueError(f"Duplicate profile term: {term}")
        if not isinstance(aliases, list) or any(not isinstance(value, str) or not value.strip() for value in aliases):
            raise ValueError(f"Invalid aliases for profile term: {term}")
        normalized_aliases = [value.strip() for value in aliases]
        if len(normalized_aliases) != len(set(value.casefold() for value in normalized_aliases)):
            raise ValueError(f"Duplicate aliases for profile term: {term}")
        by_term[term] = {
            "domain": domain.strip(),
            "subdomain": subdomain.strip(),
            "aliases": normalized_aliases,
        }
    term_keys = {term.casefold(): term for term in by_term}
    for term, metadata in by_term.items():
        for alias in metadata["aliases"]:
            conflicting_term = term_keys.get(alias.casefold())
            if conflicting_term is not None and conflicting_term != term:
                raise ValueError(
                    f"Alias {alias!r} for {term!r} conflicts with profile term {conflicting_term!r}"
                )
    seen_review_pairs: set[tuple[str, str]] = set()
    for review in profile.get("similarityReviews", []):
        terms = review.get("terms") if isinstance(review, dict) else None
        if not isinstance(terms, list) or len(terms) != 2 or any(term not in by_term for term in terms):
            raise ValueError("Similarity review terms must name two profile targets")
        pair = tuple(sorted(terms))
        if pair in seen_review_pairs:
            raise ValueError(f"Duplicate similarity review: {pair}")
        seen_review_pairs.add(pair)
        if review.get("disposition") != "retain-distinct-constructs" or not isinstance(review.get("rationale"), str) or not review["rationale"].strip():
            raise ValueError(f"Similarity review requires a supported disposition and rationale: {pair}")
    return profile, by_term


def load_vertices(path: Path) -> np.ndarray:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    required = {"vertex", "mni152_r", "mni152_a", "mni152_s"}
    if len(rows) != VERTEX_COUNT or not rows or not required.issubset(rows[0]):
        raise ValueError("The Cedalion vertex correspondence must contain the canonical 25,000 rows")
    indices = np.asarray([int(row["vertex"]) for row in rows], dtype=np.int32)
    if not np.array_equal(indices, np.arange(VERTEX_COUNT)):
        raise ValueError("Cedalion vertex rows are not in canonical sequential order")
    return np.asarray([
        [float(row["mni152_r"]), float(row["mni152_a"]), float(row["mni152_s"])] for row in rows
    ], dtype=np.float64)


def deterministic_npz(path: Path, arrays: dict[str, np.ndarray]) -> None:
    """Write an npz with fixed ZIP metadata so identical inputs hash identically."""
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(arrays):
            buffer = io.BytesIO()
            np.lib.format.write_array(buffer, np.ascontiguousarray(arrays[name]), allow_pickle=False)
            info = zipfile.ZipInfo(f"{name}.npy", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, buffer.getvalue(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def validate_reuse_scientific_manifest(manifest: dict[str, Any]) -> None:
    statistic = manifest.get("statistic", {})
    expected_statistic = {
        "name": "association-test z",
        "sign": "positive-only",
        "multipleComparisons": "FDR independent",
        "alpha": FDR_ALPHA,
    }
    if any(statistic.get(key) != value for key, value in expected_statistic.items()):
        raise ValueError("Reuse pack statistic definition mismatch")
    generation = manifest.get("generation", {})
    expected_generation = {
        "nimareVersion": NIMARE_VERSION,
        "nimareTagCommit": NIMARE_TAG_COMMIT,
        "estimator": "MKDAChi2",
        "kernelRadiusMm": KERNEL_RADIUS_MM,
        "termTfidfThresholdExclusive": TERM_THRESHOLD,
        "vertexSampling": "nearest FDR support plus trilinear z at official Cedalion mni152_r/a/s",
        "sourceSpace": "NeurosynthMNI152-2mm",
    }
    if any(generation.get(key) != value for key, value in expected_generation.items()):
        raise ValueError("Reuse pack scientific pipeline mismatch")


def validate_reuse_sparse_data(
    manifest: dict[str, Any], catalog: list[dict[str, Any]], indices: np.ndarray,
    values: np.ndarray, offsets: np.ndarray,
) -> None:
    if offsets.shape != (len(catalog) + 1,) or int(offsets[-1]) != len(indices) or values.shape != indices.shape:
        raise ValueError("Reuse pack sparse arrays are inconsistent")
    if manifest.get("qc", {}).get("passed") is not True:
        raise ValueError("Reuse pack did not pass recorded QC")
    for index, record in enumerate(catalog):
        start, stop = int(offsets[index]), int(offsets[index + 1])
        term_indices, term_values = indices[start:stop], values[start:stop]
        if len(term_indices) == 0 or np.any(np.diff(term_indices.astype(np.int32)) <= 0):
            raise ValueError(f"Reuse pack has invalid vertex indices for {record.get('label')}")
        if not np.all(np.isfinite(term_values)) or np.any(term_values <= 0):
            raise ValueError(f"Reuse pack has invalid values for {record.get('label')}")
        map_digest = hashlib.sha256()
        map_digest.update(term_indices.astype("<u2", copy=False).tobytes(order="C"))
        map_digest.update(term_values.astype("<f2", copy=False).tobytes(order="C"))
        if map_digest.hexdigest() != record.get("mapSha256"):
            raise ValueError(f"Reuse pack map digest mismatch for {record.get('label')}")


def load_reusable_maps(
    roots: list[Path], vertices_path: Path, source: Path,
) -> dict[str, tuple[int, np.ndarray, dict[str, Any]]]:
    """Load previously generated maps only after validating all scientific gates."""
    reusable: dict[str, tuple[int, np.ndarray, dict[str, Any]]] = {}
    expected_source_hashes = {
        path.name: sha256(path) for path in sorted(source.glob("data-neurosynth_version-7_*"))
    }
    for root in roots:
        manifest_path, catalog_path, maps_path = (
            root / "manifest.json", root / "catalog.json", root / "maps.npz"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        if manifest.get("format") != "cortexlume-quick-target-pack" or manifest.get("formatVersion") != 1:
            raise ValueError(f"Reuse pack has unsupported format: {root}")
        if manifest.get("distributionRole") != "release" or manifest.get("space") != "MNI152NLin6Asym":
            raise ValueError(f"Reuse pack is not a release pack in the locked space: {root}")
        try:
            validate_reuse_scientific_manifest(manifest)
        except ValueError as error:
            raise ValueError(f"{error}: {root}") from error
        if manifest.get("source", {}).get("commit") != NEUROSYNTH_COMMIT:
            raise ValueError(f"Reuse pack source commit mismatch: {root}")
        if manifest.get("surface", {}).get("correspondenceSha256") != sha256(vertices_path):
            raise ValueError(f"Reuse pack surface correspondence mismatch: {root}")
        recorded_source_hashes = {
            name: item.get("sha256") for name, item in manifest.get("source", {}).get("files", {}).items()
        }
        if recorded_source_hashes != expected_source_hashes:
            raise ValueError(f"Reuse pack Neurosynth source hashes mismatch: {root}")
        for name, path in (("catalog.json", catalog_path), ("maps.npz", maps_path)):
            if manifest.get("files", {}).get(name, {}).get("sha256") != sha256(path):
                raise ValueError(f"Reuse pack file hash mismatch ({name}): {root}")
        with np.load(maps_path, allow_pickle=False) as archive:
            indices = np.asarray(archive["vertex_indices"], dtype=np.uint16)
            values = np.asarray(archive["z_values"], dtype=np.float16)
            offsets = np.asarray(archive["offsets"], dtype=np.uint32)
        try:
            validate_reuse_sparse_data(manifest, catalog, indices, values, offsets)
        except ValueError as error:
            raise ValueError(f"{error}: {root}") from error
        qc_by_id = {item.get("id"): item for item in manifest.get("qc", {}).get("maps", [])}
        for index, record in enumerate(catalog):
            term = str(record["label"])
            start, stop = int(offsets[index]), int(offsets[index + 1])
            term_indices = indices[start:stop]
            term_values = values[start:stop]
            dense = np.zeros(VERTEX_COUNT, dtype=np.float32)
            dense[term_indices.astype(np.int32)] = term_values.astype(np.float32)
            existing = reusable.get(term)
            candidate = (int(record.get("studyCount", 0)), dense, dict(qc_by_id.get(record["id"], {})))
            if existing is not None and not np.array_equal(existing[1], dense):
                raise ValueError(f"Conflicting reusable maps for term: {term}")
            reusable[term] = candidate
    return reusable


def laterality(values: np.ndarray, vertices: np.ndarray) -> str:
    left = float(np.sum(values[vertices[:, 0] < -2]))
    right = float(np.sum(values[vertices[:, 0] > 2]))
    total = left + right
    if total == 0 or abs(left - right) / total < 0.2:
        return "bilateral"
    return "left" if left > right else "right"


def sample_image_to_vertices(image: Any, vertices: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    from scipy.ndimage import map_coordinates

    data = np.asarray(image.dataobj, dtype=np.float32)
    if data.ndim != 3 or not np.all(np.isfinite(image.affine)) or abs(np.linalg.det(image.affine[:3, :3])) < 1e-8:
        raise ValueError("Association map must be a finite-affine 3D NIfTI")
    voxels = np.c_[vertices, np.ones(len(vertices))] @ np.linalg.inv(image.affine).T
    voxels = voxels[:, :3]
    shape = np.asarray(data.shape)
    inside = np.all((voxels >= 0) & (voxels <= shape - 1), axis=1)
    if float(np.mean(inside)) < 0.95:
        raise ValueError("Association map grid does not cover at least 95% of the Cedalion cortex")
    sampled = np.zeros(VERTEX_COUNT, dtype=np.float32)
    sampled[inside] = map_coordinates(data, voxels[inside].T, order=1, mode="constant", cval=0.0)
    # The z volume has already been masked by the corrected p map. Preserve
    # that discrete FDR support with nearest-neighbour sampling while using
    # trilinear interpolation only for the displayed z magnitude.
    significant = np.zeros(VERTEX_COUNT, dtype=bool)
    significant[inside] = map_coordinates(
        (data > 0).astype(np.uint8), voxels[inside].T, order=0, mode="constant", cval=0,
    ).astype(bool)
    sampled[~significant | ~np.isfinite(sampled) | (sampled <= 0)] = 0
    return sampled, {
        "inputShape": list(data.shape),
        "inputAffine": np.asarray(image.affine).round(8).tolist(),
        "vertexGridCoverage": round(float(np.mean(inside)), 8),
    }


def choose_association_map(result: Any) -> Any:
    import nibabel as nib

    z_candidates = [
        name for name in result.maps
        if "z_desc-association" in name and ("corr-FDR" in name or "corr-fdr" in name)
    ]
    p_candidates = [
        name for name in result.maps
        if name.startswith("p_desc-association") and ("corr-FDR" in name or "corr-fdr" in name)
    ]
    if len(z_candidates) != 1 or len(p_candidates) != 1:
        raise RuntimeError(
            f"Expected one FDR association z and p map, found z={z_candidates}, p={p_candidates}"
        )
    z_image = result.get_map(z_candidates[0], return_type="image")
    p_image = result.get_map(p_candidates[0], return_type="image")
    z_data = np.asarray(z_image.dataobj, dtype=np.float32)
    p_data = np.asarray(p_image.dataobj, dtype=np.float32)
    significant_positive = np.isfinite(z_data) & np.isfinite(p_data) & (z_data > 0) & (p_data <= FDR_ALPHA)
    return nib.Nifti1Image(np.where(significant_positive, z_data, 0), z_image.affine, z_image.header)


def neurosynth_maps(source: Path, terms: list[str] | None) -> Iterable[tuple[str, int, np.ndarray, dict[str, Any]]]:
    """Yield FDR-corrected positive association fields using pinned NiMARE."""
    import nibabel as nib
    import nimare
    import pandas as pd
    from nimare.correct import FDRCorrector
    from nimare.io import convert_neurosynth_to_dataset
    from nimare.meta.cbma.mkda import MKDAChi2
    from scipy import sparse

    if nimare.__version__ != NIMARE_VERSION:
        raise RuntimeError(f"NiMARE {NIMARE_VERSION} is required; found {nimare.__version__}")
    coordinates = source / "data-neurosynth_version-7_coordinates.tsv.gz"
    metadata = source / "data-neurosynth_version-7_metadata.tsv.gz"
    features = source / "data-neurosynth_version-7_vocab-terms_source-abstract_type-tfidf_features.npz"
    vocabulary = source / "data-neurosynth_version-7_vocab-terms_vocabulary.txt"
    for path in (coordinates, metadata, features, vocabulary):
        if not path.is_file():
            raise FileNotFoundError(path)

    term_names = [line.strip() for line in vocabulary.read_text(encoding="utf-8").splitlines() if line.strip()]
    feature_matrix = sparse.load_npz(features).tocsr()
    metadata_frame = pd.read_table(metadata)
    if feature_matrix.shape != (len(metadata_frame), len(term_names)):
        raise ValueError("Neurosynth metadata, vocabulary, and feature matrix do not align")
    selected_terms = term_names if terms is None else terms
    missing = sorted(set(selected_terms) - set(term_names))
    if missing:
        raise ValueError(f"Terms not found in the pinned Neurosynth vocabulary: {missing}")
    if terms is not None:
        below_minimum = [
            term for term in selected_terms
            if int(np.count_nonzero(np.asarray(feature_matrix[:, term_names.index(term)].toarray()).ravel() > TERM_THRESHOLD)) < 20
        ]
        if below_minimum:
            raise ValueError(f"Terms do not meet the >=20 selected-study gate: {below_minimum}")

    dataset = convert_neurosynth_to_dataset(
        coordinates, metadata,
        annotations_files=[{"features": str(features), "vocabulary": str(vocabulary)}],
        target="mni152_2mm",
    )
    # The converter represents each Neurosynth paper as one analysis and appends
    # ``-1`` to its metadata study id. Feature rows remain in metadata order.
    study_ids = [f"{value}-1" for value in metadata_frame["id"].astype(str)]
    dataset_ids = set(dataset.ids)
    if not set(study_ids).issubset(dataset_ids):
        missing_ids = len(set(study_ids) - dataset_ids)
        raise ValueError(f"NiMARE conversion lost {missing_ids} metadata-aligned study ids")
    for term in selected_terms:
        column = term_names.index(term)
        selected_mask = np.asarray(feature_matrix[:, column].toarray()).ravel() > TERM_THRESHOLD
        selected_ids = [study_ids[index] for index in np.flatnonzero(selected_mask)]
        unselected_ids = [study_ids[index] for index in np.flatnonzero(~selected_mask)]
        if len(selected_ids) < 20:
            continue
        estimator = MKDAChi2(kernel__r=KERNEL_RADIUS_MM, prior=None)
        uncorrected = estimator.fit(dataset.slice(selected_ids), dataset.slice(unselected_ids))
        corrected = FDRCorrector(method="indep", alpha=FDR_ALPHA).transform(uncorrected)
        image = choose_association_map(corrected)
        yield term, len(selected_ids), image, {
            "inputMapSha256": hashlib.sha256(np.asarray(image.dataobj).tobytes(order="C")).hexdigest(),
            "niftiOrientation": "".join(nib.aff2axcodes(image.affine)),
        }


def fixture_maps(vertices: np.ndarray) -> Iterable[tuple[str, int, np.ndarray, dict[str, Any]]]:
    # Approximate peaks only exercise the UX and mapping pipeline; they are not meta-analytic results.
    specifications = {
        "working memory": [(-42, 30, 28), (42, 30, 28), (0, 18, 50)],
        "language": [(-50, 18, 16), (-48, -44, 22)],
        "motor": [(-38, -22, 56), (38, -22, 56)],
    }
    for term, peaks in specifications.items():
        values = np.zeros(VERTEX_COUNT, dtype=np.float32)
        for peak in peaks:
            squared_distance = np.sum((vertices - np.asarray(peak)) ** 2, axis=1)
            values = np.maximum(values, 6.0 * np.exp(-squared_distance / (2 * 12.0 ** 2)))
        values[values < 0.5] = 0
        yield term, 0, values, {"syntheticPeaksMni": peaks, "sigmaMm": 12, "fixtureOnly": True}


def build_pack(args: argparse.Namespace) -> None:
    vertices_path = args.vertices.resolve()
    vertices = load_vertices(vertices_path)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    profile: dict[str, Any] | None = None
    profile_targets: dict[str, dict[str, Any]] = {}
    if args.profile is not None:
        profile, profile_targets = load_profile(args.profile.resolve())
        selected_terms = list(profile_targets)
        if args.profile_shard is not None:
            shard_index, shard_count = (int(value) for value in args.profile_shard.split("/", 1))
            if shard_count < 1 or not 1 <= shard_index <= shard_count:
                raise ValueError("--profile-shard must use a 1-based INDEX/COUNT")
            selected_terms = [term for index, term in enumerate(selected_terms) if index % shard_count == shard_index - 1]
    else:
        selected_terms = args.terms

    if args.fixture:
        source_maps = fixture_maps(vertices)
        distribution_role = "test-fixture"
    else:
        source = args.neurosynth_dir.resolve()
        reusable = load_reusable_maps(
            [path.resolve() for path in args.reuse_pack], vertices_path, source,
        )
        reusable_selected = {term: reusable[term] for term in (selected_terms or []) if term in reusable}
        missing_terms = None if selected_terms is None else [term for term in selected_terms if term not in reusable_selected]
        generated = iter(neurosynth_maps(source, missing_terms))

        def selected_maps() -> Iterable[tuple[str, int, np.ndarray, dict[str, Any]]]:
            if selected_terms is None:
                yield from generated
                return
            for term in selected_terms:
                if term in reusable_selected:
                    study_count, values, previous_qc = reusable_selected[term]
                    yield term, study_count, values, {
                        **previous_qc,
                        "reusedFromValidatedPack": True,
                    }
                else:
                    generated_term, study_count, field, extra_qc = next(generated)
                    if generated_term != term:
                        raise RuntimeError(
                            f"Selected term {term!r} did not pass the study-count gate; next generated term was {generated_term!r}"
                        )
                    yield generated_term, study_count, field, extra_qc
        source_maps = selected_maps()
        distribution_role = "release"

    catalog: list[dict[str, Any]] = []
    all_indices: list[np.ndarray] = []
    all_values: list[np.ndarray] = []
    offsets = [0]
    map_qc: list[dict[str, Any]] = []
    excluded_targets: list[dict[str, Any]] = []
    for term, study_count, field, extra_qc in source_maps:
        if hasattr(field, "affine"):
            values, grid_qc = sample_image_to_vertices(field, vertices)
        else:
            values, grid_qc = np.asarray(field, dtype=np.float32), {}
        indices = np.flatnonzero(np.isfinite(values) & (values > 0)).astype(np.uint16)
        positive = values[indices].astype(np.float32)
        if len(indices) == 0:
            target_metadata = profile_targets.get(term, {})
            excluded_targets.append({
                "term": term,
                "studyCount": study_count,
                "reason": "no-positive-FDR-surface-support",
                **({"domain": target_metadata["domain"], "subdomain": target_metadata["subdomain"]}
                   if target_metadata else {}),
            })
            continue
        quantized = positive.astype(np.float16)
        map_digest = hashlib.sha256()
        map_digest.update(indices.astype("<u2", copy=False).tobytes(order="C"))
        map_digest.update(quantized.astype("<f2", copy=False).tobytes(order="C"))
        target_id = slug(term)
        target_metadata = profile_targets.get(term, {})
        catalog.append({
            "id": target_id,
            "label": term,
            "aliases": target_metadata.get("aliases", []),
            **({"domain": target_metadata["domain"], "subdomain": target_metadata["subdomain"]}
               if target_metadata else {}),
            "studyCount": study_count,
            "laterality": laterality(values, vertices),
            "description": "Positive FDR-corrected Neurosynth association z map" if not args.fixture else "Synthetic interaction-test field; not a Neurosynth result",
            "nonzeroVertexCount": len(indices),
            "valueRange": [float(np.min(quantized)), float(np.max(quantized))],
            "threshold": {"kind": "FDR-corrected-positive", "alphaInclusive": FDR_ALPHA},
            "mapSha256": map_digest.hexdigest(),
        })
        all_indices.append(indices)
        all_values.append(quantized)
        offsets.append(offsets[-1] + len(indices))
        map_qc.append({
            "id": target_id,
            "strictlyIncreasingUniqueIndices": bool(np.all(np.diff(indices.astype(np.int32)) > 0)),
            "finitePositiveValues": bool(np.all(np.isfinite(quantized)) and np.all(quantized > 0)),
            "float16MaxAbsoluteError": float(np.max(np.abs(positive - quantized.astype(np.float32)))),
            **grid_qc,
            **extra_qc,
        })
    if not catalog:
        raise RuntimeError("No nonempty Quick Target maps were produced")

    write_json(output / "catalog.json", catalog)
    deterministic_npz(output / "maps.npz", {
        "offsets": np.asarray(offsets, dtype=np.uint32),
        "vertex_indices": np.concatenate(all_indices).astype(np.uint16),
        "z_values": np.concatenate(all_values).astype(np.float16),
    })
    dense_maps = np.zeros((len(catalog), VERTEX_COUNT), dtype=np.float32)
    for index, (indices, values) in enumerate(zip(all_indices, all_values)):
        dense_maps[index, indices.astype(np.int32)] = values.astype(np.float32)
    correlations = np.corrcoef(dense_maps) if len(catalog) > 1 else np.ones((1, 1))
    similarity_reviews = {
        tuple(sorted(review["terms"])): review
        for review in (profile or {}).get("similarityReviews", [])
    }
    similarity_pairs = sorted((
        {
            "leftId": catalog[left]["id"],
            "rightId": catalog[right]["id"],
            "pearsonR": round(float(correlations[left, right]), 6),
            "reviewStatus": (
                "reviewed-retained" if tuple(sorted((catalog[left]["label"], catalog[right]["label"]))) in similarity_reviews
                else "requires-semantic-review"
            ),
            **({
                "disposition": similarity_reviews[tuple(sorted((catalog[left]["label"], catalog[right]["label"])))]["disposition"],
                "rationale": similarity_reviews[tuple(sorted((catalog[left]["label"], catalog[right]["label"])))]["rationale"],
            } if tuple(sorted((catalog[left]["label"], catalog[right]["label"]))) in similarity_reviews else {}),
        }
        for left in range(len(catalog)) for right in range(left + 1, len(catalog))
        if np.isfinite(correlations[left, right]) and correlations[left, right] >= MAP_SIMILARITY_REVIEW_THRESHOLD
    ), key=lambda item: (-item["pearsonR"], item["leftId"], item["rightId"]))
    source_files = {}
    if not args.fixture:
        for path in sorted(args.neurosynth_dir.resolve().glob("data-neurosynth_version-7_*")):
            source_files[path.name] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    manifest = {
        "format": "cortexlume-quick-target-pack",
        "formatVersion": 1,
        "packId": args.pack_id,
        "distributionRole": distribution_role,
        "space": "MNI152NLin6Asym",
        "statistic": {
            "name": "association-test z",
            "sign": "positive-only",
            "multipleComparisons": "FDR independent",
            "alpha": FDR_ALPHA,
        },
        "source": {
            "name": "Neurosynth" if not args.fixture else "CortexLume synthetic fixture",
            "databaseVersion": NEUROSYNTH_VERSION if not args.fixture else None,
            "repository": NEUROSYNTH_REPOSITORY,
            "commit": NEUROSYNTH_COMMIT,
            "license": "ODbL-1.0",
            "files": source_files,
        },
        "generation": {
            "generator": "scripts/build_quick_target_pack.py",
            "nimareVersion": NIMARE_VERSION,
            "nimareTagCommit": NIMARE_TAG_COMMIT,
            "estimator": "MKDAChi2",
            "kernelRadiusMm": KERNEL_RADIUS_MM,
            "termTfidfThresholdExclusive": TERM_THRESHOLD,
            "vertexSampling": "nearest FDR support plus trilinear z at official Cedalion mni152_r/a/s",
            "sourceSpace": "NeurosynthMNI152-2mm" if not args.fixture else "synthetic-MNI-fixture",
            "storage": "sparse uint16 vertex indices + float16 positive z values",
            **({
                "profileId": profile["profileId"],
                "profileSha256": sha256(args.profile.resolve()),
                "profileTargetCount": len(profile["targets"]),
                "profileShard": args.profile_shard,
            } if profile is not None else {}),
        },
        "surface": {
            "name": "Cedalion ICBM152 brain scientific",
            "version": "26.5.1",
            "vertexCount": VERTEX_COUNT,
            "ordering": "brain_vertex_coordinates.csv vertex column",
            "correspondenceSha256": sha256(vertices_path),
        },
        "qc": {
            "passed": all(item["strictlyIncreasingUniqueIndices"] and item["finitePositiveValues"] for item in map_qc),
            "termCount": len(catalog),
            "candidateTermCount": len(catalog) + len(excluded_targets),
            "excludedTargets": excluded_targets,
            "domainCounts": dict(sorted(Counter(record.get("domain", "Uncategorized") for record in catalog).items())),
            "mapSimilarity": {
                "metric": "Pearson correlation across all 25,000 surface vertices, including zero support",
                "reviewThresholdInclusive": MAP_SIMILARITY_REVIEW_THRESHOLD,
                "pairs": similarity_pairs,
            },
            "smallSurfaceSupport": {
                "reviewThresholdExclusive": SMALL_SURFACE_SUPPORT_THRESHOLD,
                "maps": [
                    {"id": record["id"], "nonzeroVertexCount": record["nonzeroVertexCount"]}
                    for record in catalog if record["nonzeroVertexCount"] < SMALL_SURFACE_SUPPORT_THRESHOLD
                ],
            },
            "maps": map_qc,
        },
        "files": {
            "catalog.json": {"sha256": sha256(output / "catalog.json")},
            "maps.npz": {"sha256": sha256(output / "maps.npz")},
        },
    }
    write_json(output / "manifest.json", manifest)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--vertices", type=Path, default=Path("assets/templates/MNI152NLin6Asym/generated/brain_vertex_coordinates.csv"))
    parser.add_argument("--neurosynth-dir", type=Path)
    parser.add_argument("--term", dest="terms", action="append", help="Exact vocabulary term; repeat to build a subset")
    parser.add_argument("--profile", type=Path, help="Versioned curated target profile")
    parser.add_argument("--profile-shard", help="Build a deterministic 1-based INDEX/COUNT shard of --profile")
    parser.add_argument(
        "--reuse-pack", type=Path, action="append", default=[],
        help="Reuse maps from a fully hash- and pipeline-validated release pack; repeatable",
    )
    parser.add_argument("--pack-id", default="neurosynth-v7-nimare-0.20.0")
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()
    if not args.fixture and args.neurosynth_dir is None:
        parser.error("--neurosynth-dir is required unless --fixture is used")
    if args.fixture and args.neurosynth_dir is not None:
        parser.error("--fixture and --neurosynth-dir are mutually exclusive")
    if args.fixture and (args.profile is not None or args.reuse_pack or args.profile_shard is not None):
        parser.error("--fixture cannot be combined with profiles, shards, or release-pack reuse")
    if args.profile is not None and args.terms:
        parser.error("--profile and --term are mutually exclusive")
    if args.profile_shard is not None and args.profile is None:
        parser.error("--profile-shard requires --profile")
    return args


if __name__ == "__main__":
    try:
        build_pack(parse_args())
    except Exception as error:
        print(f"Quick Target build failed: {error}", file=sys.stderr)
        raise
