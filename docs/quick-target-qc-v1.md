# Quick Target curated v1 QC report

This report reviews `cortexlume-fnirs-curated-v1`, generated from the pinned
Neurosynth v0.7 source and the locked CortexLume/NiMARE/Cedalion pipeline
documented in `quick-target-data.md`.

## Release result

- Profile candidates: 133 exact Neurosynth vocabulary terms.
- Included maps: 132 real, nonempty positive FDR-corrected surface maps.
- Excluded: `awareness` (290 selected studies), reason
  `no-positive-FDR-surface-support`.
- Catalog size: 82,037 bytes.
- Sparse map archive size: 770,306 bytes.
- Manifest size: 126,993 bytes.

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
pack. That repeat took exactly 63.00 seconds and produced byte-identical files:

| File | SHA-256 |
| --- | --- |
| `catalog.json` | `5604ac0a70257867b80a64e238bb42aec33abd05762aacb837139e20bd34f979` |
| `maps.npz` | `81af86406777cd484d0b39c2cc6ad7219e2e25a22479b87eeb85d565494d1533` |
| `manifest.json` | `5434537a0b5e41a70b9940c8ce4852d4ec52491f45ab685fd96a6b31afc55ad3` |

A one-new-map benchmark (`memory encoding`) took 72.63 seconds including the
one-time Neurosynth-to-NiMARE dataset conversion. Incremental reuse never trusts
filenames alone: it verifies pack/source hashes, scientific parameters, source
commit, surface correspondence, recorded QC, every sparse slice, and each
per-map digest before accepting a map.
