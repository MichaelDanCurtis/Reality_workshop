#!/bin/bash
# Build the official pinned source locally; no Gatekeeper overrides.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'This helper is for macOS.'; exit 1; }
workshop_engine_root="${WORKSHOP_ENGINE_ROOT:-$HOME/Library/Application Support/studio.realityworkshop.desktop/engines}"
workshop_source="$workshop_engine_root/sources/darktable-5.6.1"
workshop_build="$workshop_engine_root/build/darktable-5.6.1"
workshop_revision=03179f8e080aa9cedebfe14b098b7ba88940a292
brew install cmake ninja gtk+3 gtk-mac-integration json-glib lensfun libraw exiv2 pugixml libomp intltool iso-codes potrace
if [[ ! -d "$workshop_source/.git" ]]; then
  git clone --depth 1 --branch release-5.6.1 https://github.com/darktable-org/darktable.git "$workshop_source"
fi
[[ "$(git -C "$workshop_source" rev-parse HEAD)" == "$workshop_revision" ]] || { echo 'Source revision differs from the reviewed release.'; exit 1; }
git -C "$workshop_source" submodule update --init --depth 1 src/external/rawspeed src/external/libxcf src/external/whereami src/external/LibRaw
workshop_sdk="$(xcrun --show-sdk-path)"
# This host's 27 SDK and linker disagree on arm64e.x1; the installed 26.5 SDK works.
if [[ -d /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk ]]; then
  workshop_sdk=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
fi
cmake -S "$workshop_source" -B "$workshop_build" -G Ninja \
  -DCMAKE_OSX_SYSROOT="$workshop_sdk" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$workshop_engine_root/darktable" \
  -DCMAKE_PREFIX_PATH="$(brew --prefix)" \
  -DCMAKE_C_FLAGS=-Wno-error=thread-safety-analysis \
  -DCMAKE_CXX_FLAGS=-Wno-error=macro-redefined \
  -DUSE_OPENCL=OFF -DUSE_OPENMP=OFF -DUSE_LUA=OFF -DUSE_GMIC=OFF -DUSE_AI=OFF \
  -DBUILD_TESTING=OFF -DBUILD_CURVE_TOOLS=OFF -DBUILD_NOISE_TOOLS=OFF
cmake --build "$workshop_build" --parallel 8
cmake --install "$workshop_build"
"$workshop_engine_root/darktable/bin/darktable-cli" --version
