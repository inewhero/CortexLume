from __future__ import annotations

import json
import time
from uuid import UUID

import numpy as np
import pytest
from pydantic import ValidationError

from cortexlume_science.anatomical_coverage import (
    AnatomicalCoverageEngine,
    AnatomicalCoverageError,
    SurfaceAtlasData,
    _channel_kernel,
    _canonical_path_sha256,
    _path_length_mm,
    _stable_id,
    _stable_region_color,
    load_surface_atlas_data,
    target_anatomical_profile,
)
from cortexlume_science.coverage_limits import ANATOMICAL_COVERAGE_LIMITS
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


def test_coverage_kernel_accumulation_is_streaming(monkeypatch) -> None:
    """The engine must not materialize a channels x vertices kernel matrix."""

    def fail_stack(*_args, **_kwargs):
        raise AssertionError("coverage must not stack channel kernels")

    monkeypatch.setattr(np, "stack", fail_stack)
    result = AnatomicalCoverageEngine(fixture_surface()).compute(AnatomicalCoverageRequest(
        channels=[channel(INSTANCE_A, PAIR_A, 0.0), channel(INSTANCE_B, PAIR_B, 3.0)],
        settings=settings(),
    ))
    assert len(result.channels) == 2


def test_streaming_kernel_matches_legacy_stacked_result_on_small_fixture() -> None:
    """The bounded accumulator keeps the old max/dominant/region semantics."""

    fixture = fixture_surface()
    request = AnatomicalCoverageRequest(
        channels=[
            channel(INSTANCE_B, PAIR_B, 3.0).model_copy(update={"channel_number": 22}),
            channel(INSTANCE_A, PAIR_A, 0.0).model_copy(update={"channel_number": 11}),
        ],
        settings=settings(),
    )
    result = AnatomicalCoverageEngine(fixture).compute(request)
    ordered_channels = sorted(request.channels, key=_stable_id)
    for actual, expected in zip(result.channels, ordered_channels, strict=True):
        path = np.asarray(expected.points_ras_mm, dtype=np.float64)
        assert actual.stable_id == f"{expected.instance_id}:{expected.pair_id}"
        assert actual.instance_id == expected.instance_id
        assert actual.pair_id == expected.pair_id
        assert actual.channel_number == expected.channel_number
        assert actual.path_point_count == len(path)
        assert actual.path_length_mm == pytest.approx(_path_length_mm(path), rel=1e-12, abs=1e-15)
        assert actual.path_sha256 == _canonical_path_sha256(path)

    legacy_kernels = np.stack([
        _channel_kernel(
            fixture.vertices_ras_mm,
            np.asarray(item.points_ras_mm, dtype=np.float64),
            request.settings.kernel_sigma_mm,
            request.settings.support_radius_mm,
        )
        for item in ordered_channels
    ])
    legacy_weights = legacy_kernels.max(axis=0)
    legacy_dominant = legacy_kernels.argmax(axis=0)
    valid_slots = (
        (fixture.atlas_label_indices != 255)
        & (fixture.atlas_memberships > 0)
        & (fixture.atlas_memberships >= request.settings.minimum_atlas_membership)
    )

    legacy_candidate_memberships = np.where(
        valid_slots,
        fixture.atlas_memberships,
        -1.0,
    )
    legacy_winner_slots = legacy_candidate_memberships.argmax(axis=1)
    legacy_winner_labels = fixture.atlas_label_indices[
        np.arange(fixture.atlas_label_indices.shape[0]), legacy_winner_slots
    ].astype(np.int64)
    legacy_winner_memberships = fixture.atlas_memberships[
        np.arange(fixture.atlas_memberships.shape[0]), legacy_winner_slots
    ]

    expected_geometric = np.flatnonzero(legacy_weights > 0)
    assert result.mosaic.geometric_vertex_indices == expected_geometric.tolist()
    np.testing.assert_allclose(
        result.mosaic.geometric_coverage_weights,
        legacy_weights[expected_geometric],
        rtol=1e-12,
        atol=1e-15,
    )

    expected_mosaic = np.flatnonzero((legacy_weights > 0) & np.any(valid_slots, axis=1))
    assert result.mosaic.vertex_indices == expected_mosaic.tolist()
    assert result.mosaic.dominant_channel_indices == legacy_dominant[expected_mosaic].tolist()
    np.testing.assert_allclose(
        result.mosaic.coverage_weights,
        legacy_weights[expected_mosaic],
        rtol=1e-12,
        atol=1e-15,
    )
    np.testing.assert_allclose(
        result.mosaic.atlas_memberships,
        legacy_winner_memberships[expected_mosaic],
        rtol=1e-12,
        atol=1e-15,
    )
    np.testing.assert_allclose(
        result.mosaic.opacity_weights,
        legacy_weights[expected_mosaic] * legacy_winner_memberships[expected_mosaic],
        rtol=1e-12,
        atol=1e-15,
    )

    legacy_region_masses = np.zeros(len(fixture.atlas_labels), dtype=np.float64)
    legacy_channel_region_masses = np.zeros((len(ordered_channels), len(fixture.atlas_labels)), dtype=np.float64)
    for slot in range(3):
        selected = (legacy_weights > 0) & valid_slots[:, slot]
        for label in np.unique(fixture.atlas_label_indices[selected, slot]):
            label = int(label)
            label_mask = selected & (fixture.atlas_label_indices[:, slot] == label)
            legacy_region_masses[label] += np.dot(
                legacy_weights[label_mask], fixture.atlas_memberships[label_mask, slot]
            )
            for channel_index in range(len(ordered_channels)):
                channel_mask = (legacy_kernels[channel_index] > 0) & valid_slots[:, slot]
                channel_label_mask = channel_mask & (fixture.atlas_label_indices[:, slot] == label)
                legacy_channel_region_masses[channel_index, label] += np.dot(
                    legacy_kernels[channel_index, channel_label_mask],
                    fixture.atlas_memberships[channel_label_mask, slot],
                )
    sorted_labels = sorted(
        (label for label, mass in enumerate(legacy_region_masses) if mass > 0),
        key=lambda label: (-legacy_region_masses[label], fixture.atlas_labels[label].casefold(), label),
    )
    label_to_region = {label: index for index, label in enumerate(sorted_labels)}
    expected_region_indices = [
        label_to_region[int(label)]
        for label in legacy_winner_labels[expected_mosaic]
    ]
    assert result.mosaic.region_indices == expected_region_indices

    total_region_mass = legacy_region_masses.sum()
    dominant_counts = {
        label: int(np.count_nonzero(legacy_winner_labels == label))
        for label in sorted_labels
    }
    for region in result.regions:
        label = fixture.atlas_labels.index(region.label_en)
        assert region.weighted_atlas_mass == pytest.approx(legacy_region_masses[label])
        assert region.covered_atlas_mass_fraction == pytest.approx(
            legacy_region_masses[label] / total_region_mass,
        )
        assert region.dominant_vertex_count == dominant_counts[label]
        expected_total = legacy_channel_region_masses[:, label].sum()
        expected_shares = {
            index: float(mass / expected_total)
            for index, mass in enumerate(legacy_channel_region_masses[:, label])
            if mass > 0 and expected_total > 0
        }
        assert {
            share.channel_index: share.geometric_share
            for share in region.channel_shares
        } == pytest.approx(expected_shares)


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


def _budget_channel(index: int, point_count: int, coordinate: float | None = None) -> AnatomicalCoverageChannel:
    """Build a valid, uniquely identified channel for request-boundary tests."""

    points = [
        [float(point), 0.0, 0.0] if coordinate is None else [coordinate, coordinate, coordinate]
        for point in range(point_count)
    ]
    return AnatomicalCoverageChannel(
        instanceId=UUID(int=10_000 + index),
        pairId=UUID(int=20_000 + index),
        pointsRasMm=points,
    )


def _budget_request(point_counts: list[int]) -> AnatomicalCoverageRequest:
    return AnatomicalCoverageRequest(
        channels=[_budget_channel(index, point_count) for index, point_count in enumerate(point_counts)],
    )


def test_anatomical_coverage_request_limits_accept_maximum_and_reject_maximum_plus_one() -> None:
    limits = ANATOMICAL_COVERAGE_LIMITS
    maximum_channels = limits["maximumChannels"]
    maximum_points = limits["maximumTotalPathPoints"]
    maximum_segments = limits["maximumTotalSegments"]

    # 1, maximum and maximum+1 channels.
    _budget_request([2])
    _budget_request([2] * maximum_channels)
    with pytest.raises(ValidationError, match=r"maximumChannels:129:128"):
        _budget_request([2] * (maximum_channels + 1))

    # The point budget is independently reachable: 128 channels x 125 points.
    maximum_point_counts = [maximum_points // maximum_channels] * maximum_channels
    assert sum(maximum_point_counts) == maximum_points
    _budget_request(maximum_point_counts)
    with pytest.raises(ValidationError, match="maximumTotalPathPoints"):
        _budget_request([maximum_point_counts[0] + 1, *maximum_point_counts[1:]])

    # The segment budget's +1 case uses fewer channels, keeping points within
    # the separate point budget and every path within its 129-point bound.
    maximum_segment_counts = [maximum_point_counts[0]] * maximum_channels
    assert sum(point_count - 1 for point_count in maximum_segment_counts) == maximum_segments
    _budget_request(maximum_segment_counts)
    segment_plus_one_counts = [129] * 124 + [2]
    assert sum(point_count - 1 for point_count in segment_plus_one_counts) == maximum_segments + 1
    assert sum(segment_plus_one_counts) <= maximum_points
    with pytest.raises(ValidationError, match="maximumTotalSegments"):
        _budget_request(segment_plus_one_counts)

    # High-precision coordinates exercise the independent UTF-8 serialized
    # request budget without exceeding the point/segment budgets above.
    _budget_request([125] * maximum_channels)  # control: ordinary numbers remain admissible
    with pytest.raises(ValidationError, match="maximumSerializedRequestBytes"):
        AnatomicalCoverageRequest(
            channels=[
                _budget_channel(index, 125, -1.2345678901234567e-123)
                for index in range(maximum_channels)
            ],
        )


def test_locked_surface_and_atlas_assets_pass_shape_and_hash_gate() -> None:
    load_surface_atlas_data.cache_clear()
    data = load_surface_atlas_data()
    assert data.vertices_ras_mm.shape == (25_000, 3)
    assert data.atlas_label_indices.shape == (25_000, 3)
    assert data.atlas_memberships.shape == (25_000, 3)
    assert np.isfinite(data.vertices_ras_mm).all()
    assert np.isfinite(data.atlas_memberships).all()
