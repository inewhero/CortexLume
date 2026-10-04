# Linux support (first platform expansion)

Linux support starts with **Debian 13 (trixie), x86-64**. Build locally on the
same or an older compatible glibc distribution than the target machine. A
PyInstaller sidecar built on Debian 13 is not a promise of compatibility with
older Debian/Ubuntu installations. Linux CI runs the full source checks on
Ubuntu 22.04 and 24.04, builds the portable ZIP on Ubuntu 22.04, then downloads
and tests that **same ZIP** on both Ubuntu versions. The runtime jobs verify
executable permissions and symlink integrity, planning, both downstream exports,
GUI reopening, and nonblank transparent screenshot pixels. A successful matrix,
not Debian ancestry alone, is the compatibility evidence. Windows packaging remains unchanged; macOS packaging is not yet
supported.

## Develop

Use Node.js 24, the pinned pnpm 10.30.0, and Python **3.12**. Debian 13's default
Python may be newer; provide Python 3.12 separately rather than replacing the
system Python. For example, with an existing trusted `uv` installation:

```sh
uv python install 3.12
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e 'services/science[dev]'
pnpm install --frozen-lockfile
pnpm dev
```

If `python3.12` is already available, `python3.12 -m venv .venv` followed by
`.venv/bin/python -m pip install -e 'services/science[dev]'` works too.
The GUI and MCP automatically use `.venv/bin/python`. Set `CORTEXLUME_PYTHON`
to a Python 3.12 executable to override this; paths containing spaces are supported.

Electron needs a graphical desktop and its native libraries. Typical Debian
packages include `libgtk-3-0t64`, `libnss3`, `libasound2t64`, `libgbm1`,
`libxss1`, and `libatk-bridge2.0-0t64`. For unattended testing, install `xvfb`
and run the smoke test under `xvfb-run -a`. Do not disable Chromium's sandbox
as an installation workaround; run the application as a regular user on a
system with working unprivileged user namespaces or correctly configured
Electron sandbox support. Ubuntu 24.04 can restrict unprivileged user namespaces
through AppArmor: a sandbox failure is an environment prerequisite failure, not
a reason to add `--no-sandbox`, disable AppArmor, or change system-wide sysctls.
The Ubuntu 24.04 CI runner installs an AppArmor profile granting `userns` only
to the extracted CortexLume executable, following the
[Ubuntu release guidance](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890).
Chromium's sandbox and system-wide AppArmor restrictions remain enabled.

## Verify and package

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm package:linux
xvfb-run -a pnpm smoke:packaged:mcp
# Requires a functional GL/software-rendering stack in the display session:
xvfb-run -a pnpm smoke:packaged:mcp-screenshot
```

`package:linux` builds the native science sidecar and a portable Electron ZIP:
`apps/desktop/out/make/zip/linux/<arch>/CortexLume-<version>-linux-<arch>-portable.zip`.
Extract the entire ZIP and run `./CortexLume` from its directory. Keep the
`resources` directory and sidecar together. No system Python is needed in the
packaged app. Releases also provide an amd64 `.deb` built from this same tested
portable runtime. Install it with `sudo apt install ./CortexLume-<version>-linux-amd64.deb`;
launch CortexLume from the application menu or run `cortexlume`. Remove it with
`sudo apt purge cortexlume`. The package installs under `/opt/CortexLume` and
registers its system menu entry and icon. On AppArmor 4 systems, its maintainer
scripts activate a profile allowing user namespaces only for the installed
executable; Chromium's sandbox and system-wide restrictions stay enabled.
AppImage and file associations are not provided. ARM64 paths are
architecture-aware but ARM64 binaries and science dependencies need independent
validation before claiming support.

### Publish Linux release assets

After Linux CI succeeds for the release tag's commit and the GitHub Release
exists, dispatch **Publish verified Linux release** with the tag and Linux CI
run ID. It checks that the successful run matches the tagged commit, wraps its
portable ZIP as a Debian package, and tests installation, planning, exports,
screenshots, GUI, and removal on Ubuntu 22.04 and 24.04. Only then does it upload
both formats and SHA-256 checksums directly from GitHub Actions:

```sh
gh workflow run publish-linux-release.yml -f tag=v1.3.9 -f run_id=<successful-linux-ci-run-id>
```

The packaging script can also be run on Linux against an extracted portable app:
`sh scripts/package-linux-deb.sh <app-directory> <version> <output-directory>`.

## Window and application-menu icons

The Linux package supplies its PNG directly to the native window; unlike Windows,
Linux ELF executables do not embed an application icon. Launching `./CortexLume`
therefore gives the running X11 window its icon, but a portable ZIP alone does not
register an application-menu entry. Some desktop shells, especially Wayland
shells, use a desktop entry for dock icons and grouping.

For optional **per-user** application-menu integration, first extract the package
into the permanent location where you want to keep it, then run:

```sh
./install-desktop-entry.sh
```

This installs `org.cortexlume.CortexLume.desktop` under
`${XDG_DATA_HOME:-$HOME/.local/share}/applications` and the matching PNG under
`icons/hicolor/512x512/apps`. The launcher points directly to that PNG so shells
that have not indexed a newly installed icon theme still display the logo.
It requires no root access and never runs automatically.
Open CortexLume from the application menu afterward; re-pin an old generic dock
shortcut if necessary. After moving the extracted directory, run the script again
to update its absolute launch path. Remove those two installed files to undo menu
integration. It adds no file associations. The raw `CortexLume` executable may
still have a generic file-manager icon; use the application-menu launcher instead.

## Local MCP

Use the absolute extracted executable path with `--mcp-stdio` and one
`--mcp-root=/absolute/authorized/projects` argument per approved folder.
On Linux the current Electron entrypoint still needs a display even in MCP mode;
for headless servers wrap the executable with `xvfb-run -a`.
Do not add `ELECTRON_RUN_AS_NODE` to the user's launch command.

The bundled scientific assets, project format, and authorized-root restrictions
are the same as on Windows. A valid `get_capabilities` response must report assets
ready before planning. The packaged MCP smoke test covers initialization,
capabilities, deterministic planning, saved-project inspection, downstream
exports, and GUI reopening; screenshot capture has its own smoke test.

## Next platform

macOS needs a signed app bundle, correct `.app/Contents/Resources` layout,
architecture-specific science builds, notarization/distribution decisions, and
native desktop/screenshot testing. Portable interpreter selection alone does
not constitute macOS support.
