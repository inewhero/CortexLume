# Installation and First Launch

## Install the Windows application

1. Open the [latest CortexLume release](https://github.com/inewhero/CortexLume/releases/latest).
2. Download **`CortexLume-<version>-win-x64-Setup.exe`**.
3. Run the setup executable and allow it to finish.
4. CortexLume starts automatically when installation completes. Use the new Desktop or Start Menu shortcut on later launches.

The setup executable is the normal Windows installer. The portable ZIP is for a no-install copy, and the examples ZIP contains tutorial data only.

CortexLume uses a per-user installation under `%LOCALAPPDATA%\CortexLume`; the installer does not ask for a destination folder. Windows also registers **CortexLume Workstation** under Installed apps. To remove it, use Windows Installed apps or **Uninstall CortexLume** in the Start Menu. Project files are not removed during uninstall.

## First launch

The application opens directly into three work areas: **Optode Design**, **3D Align**, and **Info Panel**. The anatomical assets load locally. Wait until the head and cortical surfaces appear before placing patches or exporting scientific results.

CortexLume works offline for layout design and scientific processing. When a network connection is available, it silently checks the GitHub release feed. If a newer stable version exists, the title bar shows the update; selecting it opens the official release page.

## Learn with the optional examples

Download `CortexLume-<version>-examples.zip` from the release page and extract it anywhere outside the application installation folder. Each case is self-contained:

- `01-quick-start`: placed standard 5 × 3 patch;
- `02-irregular-patch`: complex active-cell-mask layout;
- `03-digitizer-five-point`: interactive landmark calibration;
- `04-digitizer-polhemus`: full-array digitizer correspondence;
- `05-nifti-functional-target`: validated NIfTI functional target.

Open a `.cortexlume` file with **Info Panel → Workflow → Project → Open**.

## Portable build

The release also provides `CortexLume-<version>-win-x64-portable.zip`. Extract the entire archive before starting `CortexLume.exe`; do not run it from inside the ZIP. The portable build does not provide the installed-app entry or installer-managed shortcuts.

Next: [Design and 3D Alignment](Design-and-3D-Alignment).
