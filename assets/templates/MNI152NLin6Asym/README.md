# MNI152NLin6Asym asset gate

This directory contains reproducibly converted visualization surfaces from the
Cedalion ICBM152 v26.5.1 head model: scalp, pial gray matter, cranial white
matter, and 73 five-point/10–10 landmarks. The Electron renderer loads these
real anatomical GLBs rather than a procedural ellipsoid.

Do not set `verified` or `scienceGate.passed` manually. The release manifest is
promoted only by the reproducible asset pipeline after all source files,
correspondence assets, meshes, atlas volumes, landmarks, hashes, and QC reports
have been produced.

The visualization asset conversion is implemented by
`scripts/build_icbm152_assets.py`; source URL and SHA-256 are pinned in the
generated manifest. The full science gate is verified: Cedalion's official
vertex-MNI and voxel-to-vertex mappings are retained, vertex coordinates agree
within 0.001 mm, and the TemplateFlow target is an exact integer subgrid of the
Cedalion volume. Runtime cortical contact uses the unsimplified canonical mesh.
No template registration is applied.

The Harvard–Oxford atlas sub-gate is independently verified. CortexLume queries
a compact 1 mm index generated from the FSL HOCPAL/HOSPA probability volumes in
the TemplateFlow MNI152NLin6Asym RAS+ grid. Reported values are the original
atlas percentages at the nearest voxel; the top three are not renormalized.
`scripts/build_harvard_oxford_index.py` reproduces the index. Atlas probability
is a population-atlas voxel statistic, not subject-specific placement
confidence.
