# Anatomy display meshes

Display assets are derived from Cedalion ICBM152 v26.5.1. Scientific projection continues to use the unchanged 25,000-vertex canonical mesh and its original correspondence tables.

The pial mesh is retained when decimation breaks its closed topology. White matter is reconstructed from the binary mask with a 0.65-voxel Gaussian filter before the 0.5 isosurface extraction. Decimation uses aggression 3 and falls back to the closed source if it creates non-manifold topology.

The pial and voxel-derived surfaces can overlap locally. The builder constructs a 0.35 mm inward pial envelope, intersected with the original pial solid so sharp normal offsets cannot expand it. Manifold solid differences separate local protrusions from the larger exterior cerebellum/brainstem. Exterior components extending more than 3.5 mm from pial vertices are preserved, except sub-voxel islands smaller than 1 cubic millimetre. Local protrusions are removed as closed volumes, not by discarding visible triangles. A topology-preserving simplification with a 0.02 mm tolerance removes thin boolean-boundary triangles. Local boundary smoothing is limited to 0.1 mm per vertex and does not move distant anatomy. The result remains a closed oriented white-matter surface without clipping holes.

The build records retained-volume statistics in `anatomy-manifest.json` and rejects removal of more than 1% of the reconstructed white-matter volume, open surfaces, inconsistent winding or degenerate triangles. These are display corrections, not a new scientific anatomical segmentation. The higher-resolution meshes add approximately 15 MB to application assets.

```powershell
.venv/Scripts/python.exe -m pip install -e "services/science[assets]"
.venv/Scripts/python.exe scripts/build_icbm152_assets.py --source-dir .tmp/cedalion-v26.5.1/hm_icbm152 --output-dir assets/templates/MNI152NLin6Asym/generated --renderer-dir apps/desktop/public/anatomy
.venv/Scripts/python.exe -m pytest scripts/test_anatomy_display.py
```

After rebuilding, update the gray/white display SHA-256 entries in `assets/templates/MNI152NLin6Asym/manifest.json`. Verify that the canonical mesh, correspondence tables, scalp and landmarks retain their existing hashes.

At runtime each surface resolves its own nearest fragment, then the compositor sorts the three fragments by their actual per-pixel depth. A fixed white/gray/scalp stack is not spatially correct.
