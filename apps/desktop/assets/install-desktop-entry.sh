#!/bin/sh
# Optional per-user launcher for the extracted portable app. No root access needed.
set -eu
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
data_home=${XDG_DATA_HOME:-"${HOME:?HOME is required}/.local/share"}
case "$data_home" in /*) ;; *) echo 'XDG_DATA_HOME must be absolute.' >&2; exit 1 ;; esac
# Desktop entries cannot safely represent paths with line breaks.
carriage_return=$(printf '\r')
case "$app_dir$data_home" in *'
'*|*"$carriage_return"*) echo 'Paths with line breaks are not supported.' >&2; exit 1 ;; esac
[ -x "$app_dir/CortexLume" ] && [ -f "$app_dir/resources/icon.png" ] || {
  echo 'Run this script from the complete extracted CortexLume package.' >&2; exit 1;
}
entry="$data_home/applications/org.cortexlume.CortexLume.desktop"
icon="$data_home/icons/hicolor/512x512/apps/org.cortexlume.CortexLume.png"
marker='X-CortexLume-Portable=true'
if [ -e "$entry" ] || [ -L "$entry" ]; then
  if [ -L "$entry" ] || ! grep -qx "$marker" "$entry"; then
    echo "Refusing to replace an unrelated desktop entry: $entry" >&2; exit 1
  fi
fi
if [ -L "$icon" ] || { [ -e "$icon" ] && [ ! -f "$entry" ]; }; then
  echo "Refusing to replace an unrelated icon: $icon" >&2; exit 1
fi
# Exec has two escaping layers: argument quoting, then desktop-entry strings.
# Percent signs must be doubled so folder names cannot become field codes.
exec_path=$(printf '%s' "$app_dir/CortexLume" | sed 's/[\\"`$]/\\&/g; s/%/%%/g; s/\\/\\\\/g')
# An absolute Icon path works even when a shell has not indexed a new icon theme.
icon_path=$(printf '%s' "$icon" | sed 's/\\/\\\\/g')
mkdir -p -- "$(dirname -- "$entry")" "$(dirname -- "$icon")"
cp -- "$app_dir/resources/icon.png" "$icon"
umask 022
# Write atomically so a partially written entry can never be launched.
temporary=$(mktemp "$entry.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
cat > "$temporary" <<ENTRY
[Desktop Entry]
Type=Application
Name=CortexLume
Comment=fNIRS layout design and anatomical projection
Exec="$exec_path"
Icon=$icon_path
Terminal=false
Categories=Science;Education;
StartupWMClass=CortexLume
$marker
ENTRY
chmod 644 "$temporary"
mv -- "$temporary" "$entry"
trap - EXIT HUP INT TERM
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$data_home/applications" || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$data_home/icons/hicolor" >/dev/null 2>&1 || true
fi
printf 'Installed CortexLume launcher: %s\nKeep the extracted app in: %s\n' "$entry" "$app_dir"
