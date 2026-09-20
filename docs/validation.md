# Validation — 19 September 2026

## Observed on this Mac

- TypeScript/Vite production build and Tauri debug application bundle succeeded.
- Four frontend tests passed (geometry, wireframe, control boundaries, proposal validation).
- Four Rust tests passed (stale edits, undo/redo branching, invalid proposals, project serialization).
- npm dependency audit reported zero vulnerabilities at implementation time.
- Native main and detached wireframe windows opened. A parameter edit changed the shared revision and geometry. Subsequent edits appeared in the main window.
- Blender 5.2.1 LTS ran in a separate background process. The main editor remained interactive. A completed PNG was visually inspected, and the job also wrote a glTF source, a BLEND document, and a log. This is procedural starter geometry, not a reconstruction of a real property.
- Native Save created `artifacts/Coastal house.workshop`. After restarting, native Open restored the edited scene: width 10.2 m, length 9 m, coping 1.25 m, sun angle 87 degrees, water #42b9be.
- A live subscription-authenticated Codex App Server request returned a valid proposal for width 7 m, retaining the other scene parameters. Preview left document revision unchanged. Apply created one history step; Undo restored 10.2 m, Redo restored 7 m, and a second Undo restored the user's original scene. That original scene was saved again.

## Connection issue found and fixed

Standalone Codex 0.142.5 could start App Server but the service rejected the configured Astra model as requiring a newer runtime. The current macOS build prefers the already-installed desktop app runtime (0.155.0-alpha.9.2 in this environment). It also displays the server's actual failure message. No account credentials were copied or modified.

## Still unverified or planned

- Windows and Linux execution, packaging, signing, and installers. The included GitHub Actions matrix is prepared, not remotely executed.
- Moving windows across physical monitors, hot-unplug restoration, pen pressure, tablet input, and sustained performance on large scenes.
- Arbitrary 3D assets, CAD or layered-image round trips, RAW color management, AI image generation, iPhone capture, and a general node/scripting environment.
- Crash recovery/autosave. Save explicitly before quitting. Camera positions and undo history are not stored in the current project format.

This build is an executable first slice, not full editor parity or a release candidate.

## Photo markup increment

- Six frontend and six Rust tests passed. Added checks cover normalized coordinates across viewport sizes, out-of-image pointer clamping, degenerate selections, legacy project migration, region validation, and region save/undo/redo without changing source assets.
- Updated native macOS bundle built successfully.
- In the native Edit workspace, dragged a rectangle over an imported sample render, attached a pond instruction, and saved the region. Undo removed the region; Redo restored it. Native Save and Open restored the instruction and four normalized corner points in format 2. The original coastal project was preserved; validation used `artifacts/photo-markup-check/Photo markup check.workshop`.
- Freehand pointer capture and pressure recording are implemented, but a physical pen and a complete freehand stroke have not yet been manually verified. Rectangle mouse interaction was verified.
- Image generation remains disconnected; saved photo instructions do not claim to have modified pixels.

## Photo Studio v1 — earlier acceptance

The earlier prototype boundaries above describe prior increments; v1 supersedes them for the photo workflow.

- Seven frontend tests and thirteen Rust tests passed. Coverage includes a forty-photo batch recipe that preserves crops/rotation/source references, pixel-exact no-op processing, masked edits preserving outside pixels and alpha, crop/rotation output dimensions, PNG round-trip, JPEG alpha flattening, EXIF camera orientation, project compatibility, stale edits, undo/redo, and recovery-file round-trip.
- In the native application, imported a second PNG through the system dialog. Adjusted exposure to +1.1 stops. A live Codex request with a photo preview proposed saturation -10 and warmth +20 while preserving exposure and contrast. Apply created one undo step; Undo and Redo restored the corresponding values.
- Drew and applied a crop, rotated the photo, and saved the project. Batch previews showed one cropped/rotated photo and one full-frame photo. Applying the same color recipe preserved their individual compositions.
- Exported both PNGs through the native export flow. The cropped/rotated output is 730 × 1292; the other is 1782 × 1000. The first output was visually inspected. Source file hashes match the untouched import reference. Both outputs and `recipe.json` are in `artifacts/v1-check/Workshop-export-932df18c-85a9-4f28-8fcd-212b05872bcb/`.
- Applied and saved a region-only saturation adjustment of -40. The full-photo adjustments remained separate.
- The recovery file was independently read: it carried the correct dirty flag, original save path, and current color recipe.

Physical pen behavior, multi-monitor unplug recovery, RAW/ICC accuracy, and Windows/Linux execution remain unverified and are not claimed as accepted by these checks.

- Optimized macOS application bundle built as version 1.0.0 and copied to `releases/Reality Workshop.app`. Rust Clippy passed with warnings denied; npm audit reported zero vulnerabilities.
- Final packaged-app launch/recovery screen check was interrupted by the Mac locking. The live workflow checks above were performed in the native development build; recovery-file contents and packaged version metadata were verified independently.

- The copied Mac package initially failed resource-signature validation. Re-signing the complete local app bundle with an ad-hoc signature fixed it; strict deep signature verification passed. `npm run package:mac` now includes that packaging step. This does not constitute distribution notarization.

## Unified native Edit and Paint workspaces

- Nine frontend tests and seventeen Rust tests passed, along with Clippy with warnings denied and the optimized packaged macOS build. New checks cover native operation validation, invalid selections, stale commits, native undo/redo, and moving a portable project with its native sidecar files.
- GIMP 3.2.6 and Krita 5.3.4 were exercised through their actual installed APIs: create/open native documents, brush strokes, layers, opacity/blend, selections, transparency masks, painting masks, duplication/order/groups, native reopen, full-resolution PNG, crop/rotation, and OpenRaster transfer in both directions. The final scripted native regression sequences passed. Masked output was independently inspected: the excluded half retained no painted pixels.
- In the packaged suite, opened the coastal reference as a real XCF, added/named a layer, and painted a native GIMP stroke. Transferred layers to a separate KRA, painted using Krita, and used a live Codex proposal to set the selected layer to 50% opacity. Preview did not change the committed revision; Apply, Undo, and Redo changed the matching native revision and layer value.
- A detached Paint window displayed the same document and opacity. Portable Save wrote both XCF and KRA files beside `artifacts/engine-check/Unified studio.workshop`; restarting the packaged app restored them. Subsequent user brush work was preserved and saved before restarting the worker implementation. Full-resolution export was confirmed at 1782 × 1000 pixels.
- Repeated document operations exposed a Krita crash in deferred node-model updates. Keeping the active view alive and bounding retained document switches resolved the reproduced regression sequence. This is narrower evidence than long-session stability.
- The user reported a persistent gray square, then confirmed it belonged to another program. It was not established as a suite defect. During investigation, replaced Krita's one-time main-window hiding with a private worker window guard, rebuilt, and successfully exported the preserved painting with the QWidget guard enabled. All ten Krita operation regression jobs also passed with that guard. Qt Quick windows are also covered by the guard.

These checks establish native GIMP/Krita workbench operations, not full GIMP/Krita parity. The following increment adds the other native workspaces. Physical pen input, monitor unplug behavior, Windows/Linux, RAW/ICC fidelity, and sustained large-document performance remain unverified.


## Five-engine suite increment — 20 September 2026

- Nine frontend tests and twenty-three Rust tests passed; Clippy passed with warnings denied. TypeScript/Vite production compilation passed. New Rust checks cover spatial operation/mesh validation, native model undo/stale commits, portable model files, a forty-photo recipe retaining original paths and catalog metadata, malformed development settings, and moving originals/XMP sidecars with a project.
- Actual FreeCAD 1.1.3 worker checks created a 40 × 30 × 20 mm box (24,000 mm³), increased its length to 60 mm (36,000 mm³), subtracted a positioned cylinder, verified B-rep volume/validity, reopened FCStd, and checked STEP round-trip volume and STL export.
- Actual Blender 5.2.1 LTS checks created and changed a mesh's dimensions, transform and color, reopened BLEND, round-tripped GLB, imported CAD STL, and produced a 1200 × 900 PNG. The CAD handoff verified 60 × 30 × 20 mm becomes 0.060 × 0.030 × 0.020 m. Its small-part automatic render camera was also exercised, and the resulting cut solid was visually inspected.
- In the packaged suite, CAD controls changed the part length to 60 mm. A live Codex proposal changed its height to 25 mm while preserving other dimensions. Native preview left the shared revision unchanged; Apply, Undo and Redo restored the expected dimensions and volumes. Portable Save As wrote `artifacts/engine-check/Unified suite check.workshop` with existing GIMP/Krita work preserved.
- Built official darktable release 5.6.1 from its pinned source. Actual CLI checks verified neutral, +1 EV and full desaturation outputs, unchanged input SHA-256 values, and decoding a synthetic 16-bit CFA DNG. This proves the tested decoder path, not arbitrary camera/color-profile accuracy. Outputs are in `artifacts/darktable-check`.
- In the packaged Develop workspace, imported the coastal reference through darktable, rated it five stars, previewed +1 EV without changing the committed revision, and verified Apply/Undo/Redo. Copy to Edit completed as another native GIMP document, confirmed in the recovery manifest. The photograph original remains separate.
- The final optimized macOS package built successfully and passed strict deep ad-hoc signature verification. Python worker syntax and shell-helper syntax checks passed. Vite reports a non-blocking bundle-size warning; code splitting remains a performance follow-up.
- After the desktop was unlocked, inspected Workflow studio in the packaged app. Saved a Krita opacity script, ran the native preview without advancing revision 4, applied at revision 5 (75% opacity), and undid at revision 6 (original approximately 50% opacity). The current QWindow worker guard was active. Restarting restored the recipe, engine input, selected layer and operations.
- Live Astra photo batch: imported the alternate reference through darktable, selected both photographs, requested +0.5 EV and saturation -0.1, and inspected both engine previews while revision 7 remained unchanged. Apply committed revision 8; one Undo restored the original per-photo exposure values (1.0 EV and 0.0 EV) at revision 9. The pinned Apply/Discard controls remained visible. Tags and the existing five-star rating appeared in Library.
- Live Scene handoff converted the 60 × 30 × 25 mm FreeCAD part to a native Blender mesh with dimensions 0.060 × 0.030 × 0.025 m. Renaming updated the native scene. Wireframe mode and camera orbit remained available during background rendering. A detached Scene window showed the same model/revision; the main window displayed the completed native render.
- Saved schema 7 with three raster documents, three CAD/Blender documents (including the 104-object coastal study), two developed photos, and one workflow. Every native file/original/XMP reference was relative and present in the neighboring assets directory. The preserved KRA SHA-256 matched the original saved painting. Restarting restored this suite state.
- Coastal conversion revealed that its 104 objects exceeded the initial 100-object bound. Raised the documented bound to 256 while retaining total geometry/manifest limits. Actual Blender conversion and rendering passed for all 104 meshes. The study conversion maps real-time lighting into native sun/sky lighting and preserves its camera; the corrected output was visually inspected. Added Frame selected for close inspection within scenes that contain large background planes. The packaged app completed the handoff and saved the native BLEND. Switching between model tabs exposed a stale canvas when animation frames were throttled; immediate redraws on document, camera, and size changes corrected it. The fixed package was restarted, and switching to the coastal scene plus Frame selected visibly displayed its native meshes. The final packaged app rendered the saved coastal BLEND and displayed “Render matches this model.” A separate native Scene window showed the same 104-object document in wireframe; zoom and orbit visibly changed its view while the main window retained the render.

The old procedural coastal study and Rust photo markup tools remain available. These results establish initial native operations under one suite, not complete feature parity. Physical pen input, cross-platform execution, multi-monitor unplug handling, broad file compatibility, advanced color management, and long-session stability remain unverified.
