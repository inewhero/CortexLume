# Design and 3D Alignment

## Build a patch in Optode Design

The 2D editor starts with a standard 5 × 3, 30 mm layout. Red circles are Sources (**S**), blue circles are Detectors (**D**), and the small numbered boxes are channels.

- Use **+ Source** or **+ Detector**, then click the grid to add an optode. New and moved points snap to the 10 mm fine grid; stronger lines mark the 30 mm coarse grid.
- Choose **Select** to move or select existing points. Click empty space to clear the selection.
- Adjust **Optode Sphere** when the physical optode diameter differs from the default. Projection uses the finite sphere, not a zero-size point.
- Expand **Quick Matrix** to set columns, rows, and pitch. **Build** replaces the current layout with a regular alternating S/D matrix; **Reverse S / D** swaps all roles.
- Expand **Channel Solver** to define the accepted distance range and generate adjacent S–D channels.
- Expand **Channel Index** to edit channel numbers directly. The numbered boxes in the 2D canvas remain selectable, while the list is useful for large or multi-patch numbering schemes.

The editor fits both wide and tall layouts into the available canvas. Use the minus, percentage, and plus controls for manual zoom.

## Store and load reusable patches

Choose **Store Current** in **Patch Library** after the geometry and channel numbering are ready. Rename the layout before storing if the default name is not descriptive. Use **Load to 3D** to create an independent patch instance in the anatomical workspace.

Multiple instances can be loaded on one head. Each P01, P02, and later instance has independent placement and local optode edits. The eye control changes visibility; the × control deletes that instance.

## Place a patch in 3D Align

The 3D workspace separates camera control from patch control:

- drag the background to rotate the anatomical view;
- use **Array Control** to select **Patch** or **Single** editing;
- use the A/L/P/R controls to move the active patch over the head;
- use **−5°, −1°, +1°, +5°** to rotate its mapping in measured steps;
- enable **Single** only when one optode must be adjusted independently.

CortexLume warns when optodes from different patches are closer than the cross-patch overlap threshold. Resolve an overlap by moving or rotating the active patch, hiding a patch for inspection, or deleting the unwanted instance.

## Inspect anatomy and projection

Use **Info Panel → Anatomy Layers** to show or hide the scalp, gray matter, white matter, five-point references, 10–10 positions, position labels, channel numbers, and an active functional map. Gray- and white-matter color and opacity controls open from their color swatches.

Under **Projection**:

- **Scalp** keeps optode geometry on the scalp surface;
- **Cortex** projects inward against the cortical surface using the selected transmission depth;
- **Transmission depth from scalp** sets the default channel depth. A selected channel can carry its own instance-specific override.

Select an optode or channel in the 3D view to inspect scalp MNI, cortical MNI, distance, and the strongest Harvard–Oxford region probabilities in **Selection**. A channel is inspectable but is not moved as a single optode.

## Inspect anatomical coverage

Load at least one visible patch, then choose one of the mutually exclusive modes under **Anatomical Coverage**:

- **Overall Mosaic** colors the principal Harvard–Oxford cortical regions intersected by the channel geometry.
- **Single Region** isolates one region selected from the resulting list.

Selecting the active mode again turns coverage off. Functional Map and Anatomical Coverage are alternative overlays; their underlying data remains available when you switch views.

Next: [Functional Targeting](Functional-Targeting.md).
