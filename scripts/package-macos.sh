#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run tauri -- build --bundles app
mkdir -p releases
ditto 'src-tauri/target/release/bundle/macos/Reality Workshop.app' 'releases/Reality Workshop.app'
# Local ad-hoc signature; distribution still requires developer signing/notarization.
codesign --force --deep --sign - 'releases/Reality Workshop.app'
codesign --verify --deep --strict 'releases/Reality Workshop.app'
