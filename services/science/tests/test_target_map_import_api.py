from __future__ import annotations

import base64

from pathlib import Path

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


def test_target_import_endpoint_accepts_a_staged_file_path(tmp_path, monkeypatch) -> None:
    staging_root = tmp_path / 'cortexlume-nifti'
    staging_root.mkdir()
    staged = staging_root / 'request.nii.gz'
    staged.write_bytes(nifti_bytes())
    monkeypatch.setenv('CORTEXLUME_NIFTI_TEMP_DIR', str(staging_root))

    response = client.post('/v1/targets/import', headers=headers, json={
        'fileName': staged.name,
        'declaredSpace': 'NeurosynthMNI152-2mm',
        'filePath': str(staged),
    })
    assert response.status_code == 200, response.text
    assert response.json()['accepted'] is True


def test_target_import_endpoint_rejects_a_path_outside_the_staging_root(tmp_path, monkeypatch) -> None:
    staging_root = tmp_path / 'cortexlume-nifti'
    staging_root.mkdir()
    outside = tmp_path / 'outside.nii.gz'
    outside.write_bytes(nifti_bytes())
    monkeypatch.setenv('CORTEXLUME_NIFTI_TEMP_DIR', str(staging_root))

    response = client.post('/v1/targets/import', headers=headers, json={
        'fileName': Path(outside).name,
        'declaredSpace': 'NeurosynthMNI152-2mm',
        'filePath': str(outside),
    })
    assert response.status_code == 403
