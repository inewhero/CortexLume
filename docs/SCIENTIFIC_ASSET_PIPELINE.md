# Scientific asset pipeline

The public coordinate target is strictly `MNI152NLin6Asym`, RAS+, millimetres. Cedalion's `icbm152` archive is useful source geometry but its metadata does not identify an exact BIDS MNI variant, so its native XYZ values must never be published as NLin6Asym coordinates.

## Locked inputs

- TemplateFlow `tpl-MNI152NLin6Asym`, resolution 1 T1w and brain mask.
- TemplateFlow Harvard–Oxford `HOCPAL` and `HOSPA` probability atlases and label TSV files in the same grid.
- Cedalion 26.5.1 `hm_icbm152.zip`, SHA-256 `91bb99709b6ceadd41674acc0db6cf26d70dccb57e41797b474aa9ce6aeed3e8`, as source scalp/cortex/tissue geometry only.

All downloaded inputs must be pinned by URL, version, license, and SHA-256 before preprocessing starts.

## Reproducible transformation

1. Create source and target signed-distance channels for the brain, GM/WM boundary, and exterior head/scalp boundary.
2. Estimate a multi-metric ANTs SyN transform from the Cedalion source geometry to the TemplateFlow target. Record the exact ANTs image, command, random seed, RAS/LPS conversions, and parameters.
3. Apply the transform to surfaces and landmarks. Resample categorical tissue masks with nearest-neighbour interpolation and probabilities with linear interpolation.
4. Repair and orient the transformed meshes. Generate a canonical scientific mesh and renderer GLBs; the invisible picking mesh must retain the canonical vertex/index topology.
5. Derive and visually review Nz, Iz, LPA, RPA, Cz and the 10–10 overlay on the target scalp.
6. Generate compact 2 mm top-three label/probability arrays for provisional browser lookup. The Python service retains the 1 mm probability volumes as authority.

## Release gate

- Every target NIfTI has the expected 182×218×182 grid, 1 mm voxel size and target affine.
- Brain-mask Dice is at least 0.95.
- 95th-percentile transformed surface distance is at most 3 mm.
- Forward/inverse transform round-trip error is at most 0.5 mm on landmarks and sampled surface points.
- Canonical meshes are manifold where required, contain finite coordinates, use outward scalp normals, and pass deterministic ray-intersection fixtures.
- Harvard–Oxford golden coordinate queries reproduce the recorded top-three English labels and probabilities.
- Every generated file is included in `manifest.json` with its SHA-256.

Only a pipeline-produced manifest and a mesh-backed backend implementation may set `verified=true`. The application must continue to block BIDS coordinate export otherwise.
