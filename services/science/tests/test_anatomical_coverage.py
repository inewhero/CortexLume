from __future__ import annotations

import json
import time
from uuid import UUID

import numpy as np
import pytest

from cortexlume_science.anatomical_coverage import (
    AnatomicalCoverageEngine,
    AnatomicalCoverageError,
    SurfaceAtlasData,
    _stable_region_color,
    load_surface_atlas_data,
    target_anatomical_profile,
)
from cortexlume_science.models import (
    AnatomicalCoverageChannel,
    AnatomicalCoverageRequest,
    AnatomicalCoverageSettings,
)


INSTANCE_A = UUID("00000000-0000-4000-8000-000000000001")
INSTANCE_B = UUID("00000000-0000-4000-8000-000000000002")
PAIR_A = UUID("00000000-0000-4000-8000-000000000011")
PAIR_B = UUID("00000000-0000-4000-8000-000000000012")


def fixture_surface() -> SurfaceAtlasData:
    vertices = np.full((25_000, 3), 1_000.0, dtype=np.float64)
    vertices[:5] = np.array([
        [0.0, 0.0, 0.0],
        [4.0, 0.0, 0.0],
        [8.0, 0.0, 0.0],
        [4.0, 3.0, 0.0],
        [4.0, 8.0, 0.0],
    ])
    indices = np.full((25_000, 3), 255, dtype=np.int16)
    memberships = np.zeros((25_000, 3), dtype=np.float64)
    indices[0] = [0, 1, 255]
    memberships[0] = [0.8, 0.2, 0.0]
    indices[1] = [0, 1, 255]
    memberships[1] = [0.6, 0.3, 0.0]
    indices[2] = [1, 0, 255]
    memberships[2] = [0.9, 0.1, 0.0]
    indices[3] = [1, 0, 255]
    memberships[3] = [0.7, 0.2, 0.0]
    return SurfaceAtlasData(vertices, indices, memberships, ("Region A", "Region B"))


def channel(instance_id: UUID, pair_id: UUID, y: float) -> AnatomicalCoverageChannel:
    return AnatomicalCoverageChannel(
        instanceId=instance_id,
        pairId=pair_id,
        pointsRasMm=[[-1.0, y, 0.0], [9.0, y, 0.0]],
    )


def settings() -> AnatomicalCoverageSettings:
    return AnatomicalCoverageSettings(
        kernelSigmaMm=2.0,
        supportRadiusMm=4.0,
        minimumAtlasMembership=0.05,
    )


def test_mosaic_is_permutation_invariant_and_uses_stable_multi_patch_ids() -> None:
    engine = AnatomicalCoverageEngine(fixture_surface())
    a = channel(INSTANCE_A, PAIR_A, 0.0)
    b = channel(INSTANCE_B, PAIR_B, 3.0)
    forward = engine.compute(AnatomicalCoverageRequest(channels=[a, b], settings=settings()))
    reverse = engine.compute(AnatomicalCoverageRequest(channels=[b, a], settings=settings()))

    assert forward.model_dump(mode="json") == reverse.model_dump(mode="json")
    assert [item.stable_id for item in forward.channels] == [
        f"{INSTANCE_A}:{PAIR_A}",
        f"{INSTANCE_B}:{PAIR_B}",
    ]
    assert forward.mosaic.vertex_indices == sorted(set(forward.mosaic.vertex_indices))
    assert forward.mosaic.vertex_indices == [0, 1, 2, 3]
    assert forward.mosaic.geometric_vertex_indices == [0, 1, 2, 3]
    assert sum(region.covered_atlas_mass_fraction for region in forward.regions) == pytest.approx(1.0)
    assert {region.label_en for region in forward.regions} == {"Region A", "Region B"}
    assert all("probability" not in region.model_dump() for region in forward.regions)
    # Summary mass deliberately includes every retained top-three atlas field,
    # while the mosaic itself uses only the maximum-membership field.
    weights = dict(zip(forward.mosaic.vertex_indices, forward.mosaic.coverage_weights, strict=True))
    fixture = fixture_surface()
    for label_index, label in enumerate(fixture.atlas_labels):
        expected_mass = sum(
            weights.get(vertex, 0.0) * fixture.atlas_memberships[vertex, slot]
            for vertex in range(5)
            for slot in range(3)
            if fixture.atlas_label_indices[vertex, slot] == label_index
        )
        actual = next(region.weighted_atlas_mass for region in forward.regions if region.label_en == label)
        assert actual == pytest.approx(expected_mass)
    json.dumps(forward.model_dump(mode="json"), allow_nan=False)


def test_target_anatomical_profile_uses_planner_supplied_surface_mass(monkeypatch) -> None:
    monkeypatch.setattr(
        "cortexlume_science.anatomical_coverage.load_surface_atlas_data",
        lambda: fixture_surface(),
    )
    profile = target_anatomical_profile([0, 2], [3.0, 1.0], 0.05)
    assert profile["atlasId"]
    assert profile["atlasSupportFraction"] == pytest.approx(1.0)
    assert [region["labelEn"] for region in profile["regions"]] == ["Region A", "Region B"]
    assert sum(region["massFraction"] for region in profile["regions"]) == pytest.approx(1.0)
    assert profile["regions"][0]["massFraction"] > profile["regions"][1]["massFraction"]


def test_all_uncovered_returns_empty_mosaic_without_nan() -> None:
    engine = AnatomicalCoverageEngine(fixture_surface())
    far = AnatomicalCoverageChannel(
        instanceId=INSTANCE_A,
        pairId=PAIR_A,
        pointsRasMm=[[-1_000.0, -1_000.0, -1_000.0], [-990.0, -1_000.0, -1_000.0]],
    )
    result = engine.compute(AnatomicalCoverageRequest(channels=[far], settings=settings()))

    assert result.mosaic.vertex_indices == []
    assert result.mosaic.geometric_vertex_indices == []
    assert result.regions == []
    assert result.qc.geometric_covered_vertex_count == 0
    assert result.qc.atlas_support_fraction == 0
    assert result.qc.flags == ["no_geometric_surface_coverage"]
    json.dumps(result.model_dump(mode="json"), allow_nan=False)


def test_duplicate_instance_pair_identity_is_rejected() -> None:
    engine = AnatomicalCoverageEngine(fixture_surface())
    duplicate = channel(INSTANCE_A, PAIR_A, 2.0)
    with pytest.raises(AnatomicalCoverageError, match="coverage_channel_id_duplicate"):
        engine.compute(AnatomicalCoverageRequest(
            channels=[channel(INSTANCE_A, PAIR_A, 0.0), duplicate],
            settings=settings(),
        ))


def test_tied_channel_kernel_uses_first_stable_channel() -> None:
    engine = AnatomicalCoverageEngine(fixture_surface())
    a = channel(INSTANCE_A, PAIR_A, 0.0)
    b = channel(INSTANCE_B, PAIR_B, 0.0)
    result = engine.compute(AnatomicalCoverageRequest(channels=[b, a], settings=settings()))
    assert set(result.mosaic.dominant_channel_indices) == {0}
    assert result.channels[0].stable_id == f"{INSTANCE_A}:{PAIR_A}"


def test_region_color_is_stable_by_atlas_identity_and_label() -> None:
    color = _stable_region_color("atlas-a", "Region A")
    assert color == _stable_region_color("atlas-a", "Region A")
    assert color != _stable_region_color("atlas-a", "Region B")
    assert color != _stable_region_color("atlas-b", "Region A")


def test_geometric_coverage_without_atlas_support_is_explicit() -> None:
    engine = AnatomicalCoverageEngine(fixture_surface())
    request = AnatomicalCoverageRequest(
        channels=[AnatomicalCoverageChannel(
            instanceId=INSTANCE_A,
            pairId=PAIR_A,
            pointsRasMm=[[4.0, 8.0, 0.0], [5.0, 8.0, 0.0]],
        )],
        settings=AnatomicalCoverageSettings(
            kernelSigmaMm=1.0,
            supportRadiusMm=2.0,
            minimumAtlasMembership=0.05,
        ),
    )
    result = engine.compute(request)
    assert result.qc.geometric_covered_vertex_count == 1
    assert result.qc.atlas_labeled_vertex_count == 0
    assert result.qc.atlas_support_fraction == 0
    assert result.qc.flags == ["no_harvard_oxford_support"]
    assert result.mosaic.vertex_indices == []
    assert result.mosaic.geometric_vertex_indices == [4]
    assert result.mosaic.geometric_coverage_weights == pytest.approx([1.0])
    assert result.regions == []


def test_default_22_channel_analysis_remains_interactive() -> None:
    engine = AnatomicalCoverageEngine(fixture_surface())
    channels = []
    for index in range(22):
        x = float(index % 5)
        channels.append(AnatomicalCoverageChannel(
            instanceId=UUID(int=index + 1),
            pairId=UUID(int=index + 101),
            pointsRasMm=np.linspace([x, -2.0, 0.0], [x + 8.0, 2.0, 0.0], 33).tolist(),
        ))
    started = time.perf_counter()
    result = engine.compute(AnatomicalCoverageRequest(channels=channels))
    elapsed = time.perf_counter() - started
    assert len(result.channels) == 22
    # A generous regression ceiling accommodates shared CI hosts while still
    # catching accidental O(vertex^2) or mesh-per-region implementations.
    assert elapsed < 8.0


def test_locked_surface_and_atlas_assets_pass_shape_and_hash_gate() -> None:
    load_surface_atlas_data.cache_clear()
    data = load_surface_atlas_data()
    assert data.vertices_ras_mm.shape == (25_000, 3)
    assert data.atlas_label_indices.shape == (25_000, 3)
    assert data.atlas_memberships.shape == (25_000, 3)
    assert np.isfinite(data.vertices_ras_mm).all()
    assert np.isfinite(data.atlas_memberships).all()
