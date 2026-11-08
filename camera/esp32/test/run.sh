#!/bin/sh
# Build and run the host tests for the firmware logic (no board, no Arduino toolchain).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/evencam-host-test.$$"
CXX="${CXX:-c++}"
"$CXX" -std=c++17 -Wall -Wextra -Werror -O1 -fsanitize=address,undefined -o "$OUT" "$HERE/host_test.cpp"
trap 'rm -f "$OUT"' EXIT
"$OUT"

# Type-check the sketch itself against PC stand-ins for the Arduino API (test/stubs).
# This only catches C++ mistakes; it is NOT a firmware build.
CFG="$(mktemp -d "${TMPDIR:-/tmp}/evencam-cfg.XXXXXX")"
trap 'rm -f "$OUT"; rm -rf "$CFG"' EXIT
cp "$HERE/../even_cam/config.example.h" "$CFG/config.h"
"$CXX" -std=c++17 -fsyntax-only -Wall -Wno-unused-function -Wno-unused-variable \
  -I "$HERE/stubs" -I "$CFG" -include "$HERE/stubs/Arduino.h" -x c++ "$HERE/../even_cam/even_cam.ino"
echo "sketch type-check against stubs: ok"
