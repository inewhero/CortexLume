"""Geometric regression tests for the offline display-asset builder."""
import importlib.util
from pathlib import Path

import numpy as np
import pytest
import trimesh

spec = importlib.util.spec_from_file_location("build_anatomy", Path(__file__).with_name("build_icbm152_assets.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def test_local_protrusion_is_rebuilt_as_closed_surface():
    gray = trimesh.creation.icosphere(subdivisions=3, radius=10)
    white = trimesh.creation.icosphere(subdivisions=3, radius=9)
    white.apply_translation([1.2, 0, 0])
    result, report = builder.nest_display_white_matter(gray, white, clearance_mm=0.1)
    assert result.is_watertight and result.is_winding_consistent
    assert np.all(result.area_faces > 0)
    assert report["repairedLocalComponents"] > 0
    assert report["retainedVolumeFraction"] > 0.99
    assert np.max(np.linalg.norm(result.vertices, axis=1)) < 10
    assert np.max(np.linalg.norm(result.triangles_center, axis=1)) < 10


def test_preserves_distant_non_cortical_structures():
    gray = trimesh.creation.icosphere(subdivisions=2, radius=10)
    cerebral = trimesh.creation.icosphere(subdivisions=2, radius=5)
    distant = trimesh.creation.icosphere(subdivisions=2, radius=3)
    distant.apply_translation([0, -30, 0])
    white = trimesh.util.concatenate([cerebral, distant])
    result, report = builder.nest_display_white_matter(gray, white)
    assert result.is_watertight
    assert report["preservedNonCorticalComponents"] == 1
    assert report["retainedVolumeFraction"] == 1
    assert np.allclose(result.bounds, white.bounds)
    assert np.isclose(result.volume, white.volume, rtol=1e-6)


def test_rejects_large_loss_instead_of_silently_shredding_white_matter():
    gray = trimesh.creation.icosphere(subdivisions=2, radius=10)
    white = trimesh.creation.icosphere(subdivisions=2, radius=11)
    with pytest.raises(ValueError, match="too much white matter"):
        builder.nest_display_white_matter(gray, white)
