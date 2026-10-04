#!/bin/sh
# Wrap the already-tested portable runtime without rebuilding its binaries.
set -eu
app=$(realpath "${1:?extracted application directory required}")
version=${2:?product version required}
output=${3:?output directory required}
case "$version" in ''|*[!0-9.]*|.*) echo 'Invalid version' >&2; exit 1 ;; esac
[ "$(uname -m)" = x86_64 ] || { echo 'Only amd64 is validated' >&2; exit 1; }
test -x "$app/CortexLume"
test -x "$app/resources/cortexlume-science/cortexlume-science"
test -f "$app/resources/icon.png"
mkdir -p "$output"
output=$(realpath "$output")
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
chmod 755 "$stage"
mkdir -p "$stage/DEBIAN" "$stage/opt" "$stage/usr/bin" \
  "$stage/usr/share/applications" "$stage/usr/share/icons/hicolor/512x512/apps" \
  "$stage/usr/share/cortexlume"
cp -a "$app" "$stage/opt/CortexLume"
ln -s /opt/CortexLume/CortexLume "$stage/usr/bin/cortexlume"
cp "$app/resources/icon.png" "$stage/usr/share/icons/hicolor/512x512/apps/org.cortexlume.CortexLume.png"
cat > "$stage/usr/share/applications/org.cortexlume.CortexLume.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=CortexLume
Comment=fNIRS layout design and anatomical projection
Exec=/opt/CortexLume/CortexLume
Icon=org.cortexlume.CortexLume
Terminal=false
Categories=Science;Education;
StartupWMClass=CortexLume
EOF
# Activate only on AppArmor versions with the userns ABI (Ubuntu 24.04+).
# Keep this outside /etc/apparmor.d on older parsers; never disable the sandbox.
cat > "$stage/usr/share/cortexlume/apparmor-profile" <<'EOF'
abi <abi/4.0>,
profile cortexlume /opt/CortexLume/CortexLume flags=(unconfined) {
  userns,
}
EOF
cat > "$stage/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -eu
if [ "$1" = configure ] && [ -f /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
  profile=/etc/apparmor.d/cortexlume
  if [ ! -e "$profile" ] && [ ! -L "$profile" ]; then
    ln -s /usr/share/cortexlume/apparmor-profile "$profile"
  fi
  if [ -d /sys/kernel/security/apparmor ]; then
    apparmor_parser -r "$profile"
  fi
fi
EOF
cat > "$stage/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -eu
case "$1" in remove|purge)
  profile=/etc/apparmor.d/cortexlume
  if [ "$(readlink "$profile" 2>/dev/null || true)" = /usr/share/cortexlume/apparmor-profile ]; then
    # The payload may already be removed. Unload by its stable profile name.
    if [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1; then
      printf 'profile cortexlume /opt/CortexLume/CortexLume {}\n' | apparmor_parser -R || true
    fi
    rm -f "$profile"
  fi
esac
EOF
chmod 755 "$stage/DEBIAN/postinst" "$stage/DEBIAN/postrm"
# Portable archives may preserve owner-only build-directory permissions.
# System installations must remain readable/traversable by ordinary users.
chmod -R a+rX,go-w "$stage"
size=$(du -sk "$stage/opt" "$stage/usr" | awk '{sum += $1} END {print sum}')
cat > "$stage/DEBIAN/control" <<EOF
Package: cortexlume
Version: $version
Architecture: amd64
Maintainer: CortexLume <inewhero@users.noreply.github.com>
Section: science
Priority: optional
Homepage: https://github.com/inewhero/CortexLume
Installed-Size: $size
Depends: libc6 (>= 2.35), libstdc++6, libgcc-s1, libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libdrm2, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libasound2 | libasound2t64, libpango-1.0-0, libcairo2, libcups2 | libcups2t64, libdbus-1-3, libxkbcommon0
Description: fNIRS layout design and anatomical projection
 CortexLume desktop workstation with a bundled scientific computation service.
EOF
dpkg-deb --root-owner-group -Zxz --build "$stage" "$output/CortexLume-$version-linux-amd64.deb"
