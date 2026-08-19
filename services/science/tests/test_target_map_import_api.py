from __future__ import annotations

import base64

from .test_api import client, headers
from .test_target_map_import import nifti_bytes


def test_target_import_endpoint_maps_locked_neurosynth_grid() -> None:
    raw = nifti_bytes()
    response = client.post('/v1/targets/import', headers=headers, json={
        'fileName': 'working_memory_z.nii.gz',
        'declaredSpace': 'NeurosynthMNI152-2mm',
        'dataBase64': base64.b64encode(raw).decode('ascii'),
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['accepted'] is True
    assert result['map']['vertexCount'] == 25_000
    assert result['map']['provenance']['targetSurface'] == 'Cedalion-ICBM152-25k'
    assert result['map']['vertexIndices'] == sorted(set(result['map']['vertexIndices']))


def test_target_import_endpoint_rejects_unknown_template_declaration() -> None:
    response = client.post('/v1/targets/import', headers=headers, json={
        'fileName': 'target.nii.gz',
        'declaredSpace': 'MNI152NLin2009cAsym',
        'dataBase64': base64.b64encode(nifti_bytes()).decode('ascii'),
    })
    assert response.status_code == 422
