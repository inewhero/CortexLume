# MNE / Polhemus full-array calibration

`data/polhemus_full_array.eeg` contains five fiducials followed by 15 optode points in metres.

1. Open `polhemus-calibrated.cortexlume` to inspect the completed correspondence and the derived digitizer patch.
2. To repeat the import, open `polhemus-input.cortexlume`, then choose **Info Panel → Workflow → Digitizer**.
3. Select the EEG file, assign the first five points to Nz, Iz, LPA, RPA and Cz, map the remaining 15 points to P01, refresh correspondence, and confirm.

The parser intentionally sees the headerless points as `UNKNOWN`, matching common Polhemus/MNE exports; correspondence is resolved geometrically.
