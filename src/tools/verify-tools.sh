#!/bin/sh
# Build-time gate: prove the tools actually work, not merely that files exist.
#
# Twice during development a green build shipped a broken image — once because a
# file-exists check passed while the binary could not start, once because the
# gate tested a proxy operation rather than the real one. Both are exercised for
# real below.
set -e

UVT=/opt/uvtools/usr/bin/UVtoolsCmd

echo "==> verifying tools"

chmod +x "$UVT" 2>/dev/null || true

# Output match, not exit status: UVtoolsCmd --help exits 1 even when healthy.
if "$UVT" --help 2>&1 | grep -qiE 'convert|usage|command'; then
  echo "    uvtools     ok"
else
  echo "FATAL: UVtoolsCmd will not run. First lines of its output:"
  "$UVT" --help 2>&1 | head -5 | sed 's/^/      /'
  exit 1
fi

# Run the real plate export, including the hand-written 3MF writer, and confirm
# the result reads back as three separate objects.
python3 /app/src/tools/verify_mesh.py || {
  echo "FATAL: mesh tooling is broken"
  exit 1
}

echo "==> tools verified"
