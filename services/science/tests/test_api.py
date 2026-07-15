import os

from fastapi.testclient import TestClient

from cortexlume_science.app import CORTICAL_CENTROIDS, DEEP_CENTROIDS, app, region_probabilities
from .test_geometry import fixture_layout


os.environ["CORTEXLUME_TOKEN"] = "test-token"
client = TestClient(app)
headers = {"Authorization": "Bearer test-token"}


def test_health_reports_unverified_template() -> None:
    response = client.get("/v1/health", headers=headers)
    assert response.status_code == 200
    assert response.json()["templateVerified"] is False


def test_fit_returns_geometric_coordinates_and_region_labels() -> None:
    layout, instance = fixture_layout()
    payload = {
        "interactionId": "test",
        "projectRevision": 2,
        "template": {
            "id": "MNI152NLin6Asym",
            "assetVersion": "development-placeholder-0",
            "coordinateConvention": "RAS+",
            "units": "mm",
            "verified": False,
            "manifestSha256": "UNVERIFIED",
            "scalpMeshSha256": "UNVERIFIED",
            "cortexMeshSha256": "UNVERIFIED",
            "atlasSha256": "UNVERIFIED",
        },
        "layout": layout.model_dump(by_alias=True, mode="json"),
        "instance": instance.model_dump(by_alias=True, mode="json"),
    }
    response = client.post("/v1/placements/fit", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["templateVerified"] is False
    assert {item["status"] for item in body["projections"]} == {"provisional"}
    assert {item["claimLevel"] for item in body["projections"]} == {"geometric"}
    optodes = [item for item in body["projections"] if item["subjectKind"] == "optode"]
    assert all(item["underlyingCorticalRegions"][0]["labelEn"] for item in optodes)
    assert all(len(item["underlyingCorticalRegions"]) == 3 for item in optodes)


def test_region_estimators_return_ranked_top_three_candidates() -> None:
    cortical = region_probabilities((-42, 8, 62), CORTICAL_CENTROIDS, "cortex")
    deep = region_probabilities((-20, -8, 5), DEEP_CENTROIDS, "deep")
    assert len(cortical) == len(deep) == 3
    assert cortical[0].probability >= cortical[1].probability >= cortical[2].probability
    assert deep[0].label_en != "Subcortical White Matter"
