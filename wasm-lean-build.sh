#!/bin/sh
# Build the lean Qt-free WASM target.
# Reuses externals already built by the sibling sketcher_wasm_build at the
# parent checkout root, so we don't have to rebuild Boost/RDKit/etc.

set -e

BUILD_DIR=sketcher_lean_wasm_build

# Path to the parent checkout's external build (built by `pixi run wasm-build`).
# We're in a git worktree at .claude/worktrees/<name>/, so go up three levels.
EXT_ROOT="$(cd ../../../sketcher_wasm_build/external && pwd)"

CMAKE_PREFIX_PATH="${EXT_ROOT}/fmt-12.1.0;\
${EXT_ROOT}/zlib-1.3.1;\
${EXT_ROOT}/zstd-1.5.5;\
${EXT_ROOT}/boost-1.87.0;\
${EXT_ROOT}/eigen-3.4.0;\
${EXT_ROOT}/rdkit-2026.03.2;\
${EXT_ROOT}/sqlite-3.42.0"

emcmake cmake -B ${BUILD_DIR} -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_FIND_PACKAGE_PREFER_CONFIG=ON \
  -DCMAKE_PREFIX_PATH="${CMAKE_PREFIX_PATH}" \
  -DSKETCHER_LEAN_ONLY=ON \
  -DENABLE_TESTING=OFF

cmake --build ${BUILD_DIR}

echo ""
echo "=== Bundle sizes ==="
ls -lh ${BUILD_DIR}/sketcher_lean_app/ | grep -E "Sketcher|index"
