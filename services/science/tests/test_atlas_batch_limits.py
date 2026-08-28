import os

from fastapi.testclient import TestClient

from cortexlume_science.app import app
from cortexlume_science.models import CROSS_PROCESS_LIMITS


os.environ["CORTEXLUME_TOKEN"] = "test-token"
client = TestClient(app)
headers = {"Authorization": "Bearer test-token"}


def test_atlas_point_batch_rejects_max_plus_one() -> None:
    points = [{"id": str(index), "corticalRasMm": [0, 0, 0]} for index in range(
        CROSS_PROCESS_LIMITS["atlasBatchPoints"] + 1
    )]
    response = client.post(
        "/v1/atlas/query-batch",
        headers=headers,
        json={"points": points},
    )
    assert response.status_code == 422


def test_atlas_point_batch_accepts_exact_maximum() -> None:
    points = [{"id": str(index), "corticalRasMm": [0, 0, 0]} for index in range(
        CROSS_PROCESS_LIMITS["atlasBatchPoints"]
    )]
    response = client.post(
        "/v1/atlas/query-batch",
        headers=headers,
        json={"points": points},
    )
    assert response.status_code == 200, response.text
    assert len(response.json()["results"]) == 512


def test_atlas_path_batch_rejects_max_plus_one() -> None:
    items = [{"id": str(index), "points": [[0, 0, 0]]} for index in range(
        CROSS_PROCESS_LIMITS["atlasPathBatchItems"] + 1
    )]
    response = client.post(
        "/v1/atlas/query-path-batch",
        headers=headers,
        json={"items": items},
    )
    assert response.status_code == 422


def test_atlas_path_batch_accepts_exact_maximum() -> None:
    items = [{"id": str(index), "points": [[0, 0, 0]]} for index in range(
        CROSS_PROCESS_LIMITS["atlasPathBatchItems"]
    )]
    response = client.post(
        "/v1/atlas/query-path-batch",
        headers=headers,
        json={"items": items},
    )
    assert response.status_code == 200, response.text
    assert len(response.json()["results"]) == 128


def test_atlas_path_batch_rejects_max_plus_one_points_per_item() -> None:
    points = [[0, 0, 0] for _ in range(CROSS_PROCESS_LIMITS["maximumPathPointsPerChannel"] + 1)]
    response = client.post(
        "/v1/atlas/query-path-batch",
        headers=headers,
        json={"items": [{"id": "too-many-points", "points": points}]},
    )
    assert response.status_code == 422


def test_atlas_path_batch_accepts_exact_maximum_points_per_item() -> None:
    points = [[0, 0, 0] for _ in range(CROSS_PROCESS_LIMITS["maximumPathPointsPerChannel"])]
    response = client.post(
        "/v1/atlas/query-path-batch",
        headers=headers,
        json={"items": [{"id": "maximum", "points": points}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["id"] == "maximum"


def test_atlas_path_batch_returns_one_result_per_item() -> None:
    items = [
        {"id": "first", "points": [[38, -44, 48], [0, 0, -72]]},
        {"id": "second", "points": [[-52, -13, 48], [0, 0, -72]]},
    ]
    response = client.post(
        "/v1/atlas/query-path-batch",
        headers=headers,
        json={"items": items},
    )
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["results"]] == ["first", "second"]


def test_atlas_path_batch_accepts_legacy_paths_spelling() -> None:
    response = client.post(
        "/v1/atlas/query-path-batch",
        headers=headers,
        json={"paths": [{"id": "legacy", "points": [[0, 0, 0]]}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["id"] == "legacy"
