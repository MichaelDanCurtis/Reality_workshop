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

## Photo Studio v1 — current acceptance

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
