# CortexLume User Guide

CortexLume is a Windows workstation for designing fNIRS source–detector arrays, placing them on a template head, checking functional and anatomical coverage, validating digitized geometry, and exporting results for downstream analysis.

## Start here

1. [Install CortexLume and complete the first launch](Installation-and-First-Launch).
2. [Design an array and align it in 3D](Design-and-3D-Alignment).
3. Add a functional target with [Quick Target or a NIfTI map](Functional-Targeting).
4. If measured coordinates are available, [calibrate and match digitizer data](Digitizer-and-Five-Point-Calibration).
5. [Save the project or export CSV, BIDS-NIRS, BrainNet, and AtlasViewer files](Projects-and-Exports).

## The three work areas

- **Optode Design** is the 2D layout editor. Build S/D geometry, solve channels, edit channel numbers, and store reusable patch definitions here.
- **3D Align** is the anatomical workspace. Load one or more patches, place them independently, inspect projections, and compare geometry with functional or anatomical overlays.
- **Info Panel** controls the project, imports, exports, anatomy layers, projection settings, anatomical coverage, and the current selection.

The sidebars can be collapsed from the dividers. This gives the 3D workspace more room without changing the project.

## Recommended first session

Download the optional `CortexLume-*-examples.zip` from the same release page as the installer. Start with `01-quick-start/quick-start.cortexlume`, then use the other cases for irregular patches, digitizer matching, five-point entry, and NIfTI targeting. Follow the [Example Dataset guide](Example-Dataset) for the files, steps, and expected result of every case.

## Guides

- [Working with an AI Agent](Working-with-an-AI-Agent)
- [Installation and First Launch](Installation-and-First-Launch)
- [Example Dataset](Example-Dataset)
- [Design and 3D Alignment](Design-and-3D-Alignment)
- [Functional Targeting](Functional-Targeting)
- [Digitizer and Five-Point Calibration](Digitizer-and-Five-Point-Calibration)
- [Projects and Exports](Projects-and-Exports)

The human workflow for AI-assisted planning is covered in [Working with an AI Agent](Working-with-an-AI-Agent). Client configuration and tool-level operating rules remain in the repository's [Agent Guide](https://github.com/inewhero/CortexLume/blob/main/AGENT_README.md).
