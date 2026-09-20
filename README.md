# Reality Workshop — Photo Studio v1

A local desktop photo editor with a shared, reversible editing model and a Codex design partner. The first complete workflow is photo editing; the larger creative-studio direction remains in development.

## Use the application

The locally packaged Mac application is in `releases/Reality Workshop.app`. Windows and Linux share the Tauri/Rust/React foundation and have a prepared CI build matrix, but have not yet been run or released. This Mac build is a local development release, not a notarized installer.

1. Choose **New photo project**, then **Import photos** (JPEG, PNG, WebP).
2. In **Edit** or **Develop**, adjust exposure, contrast, saturation, and warmth. Use **Before** to compare. Every finished adjustment is undoable.
3. Choose **Region**, draw a freehand outline or rectangle, and **Save region**. Select it in **Editing** to adjust only that area.
4. Choose **Crop** and draw a rectangle, then **Apply crop**. Rotate and flip with the toolbar buttons. The original remains intact.
5. In **Astra**, describe a supported color change. The app sends a preview and instruction through your local Codex sign-in. Inspect the proposal, then **Apply** or **Discard**.
6. Select several photos in the strip, open **Batch**, preview the current photo's saved color settings on the set, then apply. Crops, rotations, and regional edits remain individual.
7. **Export photo(s)** writes full-size PNG/JPEG images and a recipe manifest into a new folder. It does not overwrite imported originals.
8. **Save** stores a portable `.workshop` document with source images and edits. **Save as…** creates a separate copy. A local recovery copy restores the last project after a restart; explicit Save is still the durable project-file operation.

## What v1 includes

| Area | Working behavior |
|---|---|
| Photo editing | Exposure, contrast, saturation, warmth; before/after; reversible crop, rotate, flip |
| Local adjustments | Freehand or rectangular regions with independent color settings |
| AI collaboration | Image-aware proposals for supported color controls; explicit preview/apply/discard/undo |
| Library and batch | Import multiple images, select a set, preview/copy color adjustments in one undo step |
| Files | Save/open, legacy format migration, recovery copy, full-size PNG/JPEG export with recipe manifest |
| Desktop | Shared project state, detached photo window, separate scene wireframe/render windows |
| Scene experiment | Editable coastal starter model and real background Blender render |

## Practical limits

- This is an 8-bit RGB photo workflow, not a RAW developer or a color-proofing system. Advanced ICC management, HDR/16-bit processing, EXIF export, and HEIC import are not implemented. Originals retain their embedded data in the project; finished exports do not retain all metadata.
- Up to 40 megapixels and 20 MB per imported image, up to 100 photos, with approximately 90 MB of encoded source data per project (100 MB file cap). Region data also counts toward the cap. For larger collections, split them into projects.
- Region boundaries are hard-edged. Pen pressure is recorded, but physical tablet acceptance remains unverified. Draft outlines, viewport cameras, and undo history are session-local; save a region before switching photos.
- Recovery is debounced and cannot guarantee the final fraction of a second before a crash. Failed recovery writes are reported. Keep explicit saved project files.
- AI image generation, object replacement/removal, brush painting, layers, PSD/XCF/KRA round trips, RAW workflows, parametric CAD, arbitrary 3D model import, and iPhone capture are not implemented. GIMP, Krita, darktable and FreeCAD editing adapters remain planned.
- The current workflow graph is a small executable scene recipe, not a general node editor.

## Engines and account access

Photo processing uses the open-source Rust `image` crate. It runs locally in background workers; previews use reduced-resolution images while exports process the original dimensions.

Codex is optional. On macOS the runtime bundled with ChatGPT/Codex is preferred over an older standalone CLI. Elsewhere it is discovered on PATH; `REALITY_WORKSHOP_CODEX` can point to an executable. Requests use ephemeral, read-only App Server threads with the existing local sign-in. Photo requests include an image preview. No credentials are copied into projects. Responses API and image-generation services are not connected by this subscription integration.

Blender is optional and installed separately (on PATH, or the standard macOS Applications folder). Rendering writes a PNG, glTF snapshot, Blender document and log under the application's local data folder.

## Build and verify

Install Node.js 22+, current stable Rust, and the Tauri 2 prerequisites for your operating system. Run `npm ci`, then `npm run desktop`. `npm run dev` is a read-only browser preview.

- `npm test`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
- `npm run tauri -- build --bundles app` on macOS; `npm run tauri -- build` for platform packages elsewhere.

See [v1 acceptance](docs/V1.md), [validation evidence](docs/validation.md), and [integration direction](docs/integration-notes.md). The approved interface reference is in `design/`.
