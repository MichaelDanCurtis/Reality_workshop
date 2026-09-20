# Reality Workshop — a shared creative suite

Reality Workshop puts **GIMP, Krita, darktable, Blender, and FreeCAD** behind one desktop interface. The suite owns the project, workspace layout, AI review, detached windows, and shared undo history. Each engine owns its native documents and processing.

This is a working first integration of all five engines. It exposes useful native operations in each workspace; it does not yet reproduce the full applications.

## Try it

Open `releases/Reality Workshop.app` on this Mac. This is a locally signed development build, not a notarized installer. The engines are installed separately.

| Workspace | Engine | Available now |
|---|---|---|
| Edit | GIMP 3 | XCF documents, layers/groups, brushes/erase, selections, masks and mask painting, crop/rotate, blend/opacity, adjustments, PNG export |
| Paint | Krita | KRA documents, installed brush presets, layers/groups, selections, masks and mask painting, crop/rotate, blend/opacity, PNG export |
| Develop / Library | darktable | RAW/image import, native exposure/contrast/saturation/black controls, compare original, batch preview/apply, ratings/tags/filtering, full-size PNG and XMP export |
| Scene | Blender | BLEND/GLB/glTF/STL import, native mesh preview, orbit/wireframe, primitives, dimensions/transforms, basic material color, booleans, background render, BLEND/GLB/STL export |
| CAD | FreeCAD | FCStd/STEP/BREP import, parametric box/cylinder/sphere, dimensions/transforms, native union/cut, validity/volume, FCStd/STEP/STL export |
| Workflows | Shared engine commands | Movable input/operation/review nodes, Astra proposals or JSON operation scripts, real engine previews, Apply/Discard, saved recipes, photo batch target |

1. Open a photograph in **Edit**, add a layer, and paint or mask. **Copy layers to Paint** creates a separate Krita document with the same suite controls. Choose an installed Krita brush preset.
2. Import photos or a project reference into **Develop**. Adjust the controls, preview the native darktable output, and Apply. Select several filmstrip images for one batch recipe. Rate/tag/search them in **Library**. **Copy to Edit** opens a full-resolution developed copy in GIMP.
3. In **CAD**, create a part, change its dimensions, add another solid and subtract or unite it. **Copy to Scene** creates a Blender mesh copy with millimetres converted to metres. The original parametric CAD file stays intact.
4. In **Scene**, create or open a model, orbit its mesh or wireframe, edit objects, and render in the background. **Coastal study** opens the earlier procedural house example; **Copy to Blender studio** converts that study into a native scene document.
5. In **Astra** or **Workflows**, request a supported change. The engine generates an uncommitted preview; Apply creates one shared undo step. Unsupported image synthesis is explained rather than simulated.
6. Detach a workspace onto another display. Save the project with its neighboring `.workshop-assets` directory; keep both together when moving it. Native XCF/KRA/FCStd/BLEND files, photograph originals, XMP recipes, and workflow recipes travel with the project.

The earlier Rust photo tools remain available through **Photo markup** in Develop for region instructions, reversible crop/rotate/flip, localized adjustments, and PNG/JPEG export. They are a separate legacy photo path; the default Develop workspace uses darktable.

## Handoffs and fidelity

Native files remain authoritative. Reduced canvas/mesh previews serve the common UI; full-resolution exports come from the engines. Save/reopen tests check native files, history tests check revision changes, and actual engine tests check rendered outputs independently.

GIMP–Krita transfer uses OpenRaster and creates a copy. It is not lossless for every mask, filter, vector, or engine-specific feature. FreeCAD–Blender transfer uses a tessellated STL derivative, with explicit unit conversion; it does not transfer parametric constraints. Develop–Edit creates rendered pixels while retaining the original photograph and XMP recipe. None of these handoffs replaces its source.

## Practical boundaries

- Each engine has a limited initial tool set. Text/vector editing, advanced filters, detailed brush configuration, sculpting/texture painting, CAD sketches/constraints, and broad modifier/material editing still need work.
- GIMP/Krita previews are at most 1024 pixels per side. A tiled, high-resolution viewport and native tablet-event streaming are still needed. Krita pressure is passed to native line segments; physical pen behavior and long painting sessions are unverified.
- darktable controls currently use its native basic-adjustments module, not its complete module stack. PNG exports are 8-bit. A synthetic DNG decoding test is not evidence of broad camera support, calibrated color accuracy, or ICC soft-proofing.
- Workflows currently have a fixed input → operation → review topology. Recipes and node positions are saved. Arbitrary Python, branching graphs, general node authoring, and a model-download/job ecosystem are not implemented.
- Limits include 32 raster documents (40 megapixels each), 16 model documents (up to 256 objects each), 100 developed photographs, and a 100 MB project manifest. Imported native files and photo originals are limited to 512 MB. The earlier embedded-reference path retains its 20 MB/image limit.
- Immutable native revisions support undo/recovery. Disk-cache compaction, cancellation, and restart-safe undo history remain unfinished. Save explicitly; automatic recovery is debounced. Viewport positions are not restored across restarts.
- Krita uses a hidden private worker in its desktop runtime. An existing standalone Krita process can prevent that worker from starting. Long-session resource use and independent profile isolation need further work.
- Generative image replacement, image-to-3D reconstruction, and iPhone/LiDAR capture are not connected yet. A Codex subscription connection does not provide Responses API or image-generation API billing.
- macOS engine execution has been tested locally. Windows/Linux discovery and CI configuration exist, but those platforms and physical multi-monitor unplug behavior have not been exercised here.

## Engine and AI connections

Engines run separately from the UI. Typed operations validate source identities, numeric ranges, and supported actions. Workers produce new native revisions; stale results cannot overwrite a newer project. AI uses those same operations and cannot submit arbitrary engine code.

GIMP and Krita are found on PATH and in common installation folders. `REALITY_WORKSHOP_GIMP` and `REALITY_WORKSHOP_KRITA` override their executables. The Paint adapter installs and enables a small Workshop Python extension in Krita's user profile; it processes jobs only when launched with the suite's private queue environment.

FreeCAD uses its headless command-line runtime, including the macOS `Contents/Resources/bin/freecadcmd` executable. Override with `REALITY_WORKSHOP_FREECAD_CMD`. Blender uses its background Python runtime with automatic file scripts disabled.

The darktable adapter uses `darktable-cli`; override with `REALITY_WORKSHOP_DARKTABLE_CLI`. This Mac uses an official-source build of release 5.6.1, pinned to `03179f8e080aa9cedebfe14b098b7ba88940a292`, installed under the suite's application-support directory. `scripts/build-darktable-macos.sh` documents/reproduces that CPU build. It depends on local Homebrew libraries and is not a portable bundled engine installer.

Codex requests use the existing local sign-in through App Server. The desktop-bundled runtime is preferred on macOS; `REALITY_WORKSHOP_CODEX` selects another executable. Requests include relevant document metadata and a preview for raster/photo changes. Credentials are not stored in projects.

## Build and verify

Install Node.js 22+, current stable Rust, and Tauri 2 prerequisites. Run `npm ci`, then `npm run desktop`. The browser preview is read-only.

- `npm test`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
- `npm run package:mac` builds and verifies the local macOS app.
- `python3 scripts/check-native-engines.py <private Krita queue>` exercises installed GIMP/Krita APIs. See the script header.
- `python3 scripts/check-spatial-engines.py` checks real FreeCAD/Blender files, volumes, imports/exports, units, and render output.
- `python3 scripts/check-darktable-engine.py` checks real darktable output, unchanged sources, and synthetic RAW decoding.

See [native engine architecture](docs/native-engines.md), [validation evidence](docs/validation.md), and [the larger integration direction](docs/integration-notes.md). The [design review plan](docs/design-review-plan.md) records separate product decisions and remains planned.
