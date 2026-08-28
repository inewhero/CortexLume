# Digitizer and Five-Point Calibration

Digitizer workflows compare measured head-space coordinates with a patch already placed in CortexLume. Load the relevant patch or patches into **3D Align** before choosing either import command.

## Five-point landmarks

CortexLume uses **Nz, Iz, LPA, RPA, and Cz**. These five corresponding template and measured landmarks define a similarity transform with rotation, translation, and uniform scale.

### Enter five points manually

1. Choose **Info Panel → Workflow → Import → 5-Point**.
2. Select the coordinate unit: mm, cm, or m.
3. Under **Map To**, choose one loaded patch or the complete loaded array.
4. Enter X, Y, and Z for Nz, Iz, LPA, RPA, and Cz.
5. Choose **Calibrate**.

The calibrated geometry is stored as a new derived patch in **Patch Library**. The completed source patch is hidden automatically rather than overwritten.

## Import a digitizer file

Choose **Info Panel → Workflow → Import → Digitizer**. CortexLume accepts `.csv`, `.tsv`, `.txt`, `.json`, `.pos`, `.hsp`, `.elp`, and `.eeg` coordinate files, including common delimited MNE/Polhemus exports. The parser suggests a unit, but confirm it before calibration.

1. Assign the imported points corresponding to Nz, Iz, LPA, RPA, and Cz. Recognized landmark labels are filled automatically.
2. Choose whether the acquisition belongs to one loaded patch or **All Loaded Patches**.
3. Select **Preview**.

Five landmarks and head-shape samples are excluded from the optode count. The remaining measured optode count must exactly match the selected patch scope; otherwise import is rejected.

## Review optode correspondence

After calibration, CortexLume shows measured points as gray spheres and connects each one to the nearest planned Source or Detector. The correspondence window reports the five-point RMS residual, mean match distance, and every planned-to-measured assignment.

- Drag the window header to keep the 3D view visible.
- Use **Refresh** to recompute the nearest one-to-one mapping.
- Change an assignment in the list when the automatic match is not correct.
- Confirm only after every measured point maps to one unique patch optode.

The 3D connection line blends from white at the measured point to red for a Source or blue for a Detector. This provides a direct visual check of correspondence and distance.

On confirmation, CortexLume creates a new derived patch, stores it in **Patch Library**, and hides the corresponding planned patch. The original definition and digitizer session remain in the project for provenance.

The optional examples include both `03-digitizer-five-point` and `04-digitizer-polhemus` workflows.

Next: [Projects and Exports](Projects-and-Exports.md).
