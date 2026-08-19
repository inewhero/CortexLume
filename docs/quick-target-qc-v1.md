# Quick Target curated v1 QC report

This report reviews `cortexlume-fnirs-curated-v1`, generated from the pinned
Neurosynth v0.7 source and the locked CortexLume/NiMARE/Cedalion pipeline
documented in `quick-target-data.md`.

## Release result

- Profile candidates: 133 exact Neurosynth vocabulary terms.
- Included maps: 132 real, nonempty positive FDR-corrected surface maps.
- Excluded: `awareness` (290 selected studies), reason
  `no-positive-FDR-surface-support`.
- Catalog size: 79,094 bytes.
- Sparse map archive size: 770,306 bytes.
- Manifest size: 121,469 bytes.

| Domain | Included maps |
| --- | ---: |
| Attention & Executive Control | 19 |
| Emotion & Social Cognition | 19 |
| Language | 18 |
| Memory & Learning | 17 |
| Pain & Interoception | 10 |
| Perception | 18 |
| Reward & Decision | 14 |
| Sensorimotor | 17 |

## Similarity and support review

Pearson correlation was calculated for every map pair across all 25,000
surface vertices, including zero support. No pair reached the predefined
semantic-review threshold of `r >= 0.95`, so no target was removed as an
obvious surface-map duplicate and no high-correlation retention rationale was
needed.

Two maps fall below the review threshold of 25 nonzero vertices:

| Target | Nonzero vertices | Disposition |
| --- | ---: | --- |
| sustained attention | 4 | Retained with warning; real corrected support is nonempty. |
| consciousness | 6 | Retained with warning; real corrected support is nonempty. |

These entries are scientifically valid under the release gate but spatially
sparse; users should interpret them cautiously for array planning. The warning
is machine-readable in `manifest.json` under `qc.smallSurfaceSupport`.

## Integrity and reproducibility

The final pack was regenerated from the completed, fully validated incremental
pack. The LF-normalized repeat took 60.89 seconds and produced byte-identical
files on Windows and in a Git checkout:

| File | SHA-256 |
| --- | --- |
| `catalog.json` | `4fb2d08ce9ce51fd2513735b14bc080a0e7d02ac024382de5a410ba1a4a4248b` |
| `maps.npz` | `81af86406777cd484d0b39c2cc6ad7219e2e25a22479b87eeb85d565494d1533` |
| `manifest.json` | `9ea3e0436882d95e345de0e25e45f2fab88c30a269969018a6b6a7d5ff522c0b` |

A one-new-map benchmark (`memory encoding`) took 72.63 seconds including the
one-time Neurosynth-to-NiMARE dataset conversion. Incremental reuse never trusts
filenames alone: it verifies pack/source hashes, scientific parameters, source
commit, surface correspondence, recorded QC, every sparse slice, and each
per-map digest before accepting a map.
