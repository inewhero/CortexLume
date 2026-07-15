from uuid import uuid4

from cortexlume_science.geometry import all_points_on_ellipsoid, fitted_positions, project_to_ellipsoid
from cortexlume_science.models import LayoutDefinition, LayoutInstance, Optode, Pair


def fixture_layout() -> tuple[LayoutDefinition, LayoutInstance]:
    source_id, detector_id = uuid4(), uuid4()
    layout = LayoutDefinition(
        id=uuid4(), version=1, name="fixture",
        createdAt="2026-07-14T00:00:00Z", updatedAt="2026-07-14T00:00:00Z",
        gridSpacingMm=5,
        optodes=[
            Optode(id=source_id, label="S1", type="source", uvMm=(-15, 0)),
            Optode(id=detector_id, label="D1", type="detector", uvMm=(15, 0)),
        ],
        pairs=[Pair(id=uuid4(), sourceId=source_id, detectorId=detector_id, nominalDistanceMm=30)],
    )
    instance = LayoutInstance(
        id=uuid4(), definitionId=layout.id, anchorRasMm=(-50, -5, 75),
        rotationRad=0, locked=True, overrides=[],
    )
    return layout, instance


def test_projection_is_on_development_ellipsoid() -> None:
    point = project_to_ellipsoid((20, 30, 90))
    assert all_points_on_ellipsoid([point])


def test_all_fitted_positions_stay_on_scalp() -> None:
    layout, instance = fixture_layout()
    assert all_points_on_ellipsoid(fitted_positions(layout, instance).values())
