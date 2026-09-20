# Native workspaces: common shell, independent engines

## Implemented boundary

`NativeEditor` is the common React workbench for GIMP and Krita. It draws a projected canvas and provides the same tool rail, document tabs, layers, properties, brush list, AI review, zoom, history, and detached-window conventions. Engine identity is visible. Engine-specific capabilities remain distinct.

`engines.rs` is the adapter coordinator. Opening or editing runs a typed JSON job against the real installed engine. Workers load native files, execute native API operations, save a new XCF/KRA revision, and return the engine's projection, selection mask, layer metadata, and installed brush presets. The shell does not maintain a parallel layer renderer or flatten a native file to imitate an integration.

GIMP runs a long-lived noninteractive Python batch worker. Krita runs a Python extension in its desktop process. A private-process event filter and periodic sweep suppress its main window, secondary widgets, and Qt Quick popup windows. A single startup `hide()` was insufficient for later views/popups. The guard is installed only when the worker queue environment variable is present; normal Krita sessions remain unaffected. Qt's offscreen/minimal backends crashed in this macOS Krita build at clipboard initialization; they are not the supported hosting path. No external desktop UI automation is used for editing. The extension calls `Document`, `Node`, `View`, and brush APIs directly.

The Krita worker retains its active document/view between consecutive revisions. Closing a view after each job caused a crash in queued `KisNodeModel` updates in the installed build. Switching to another immutable revision opens a fresh retained view, and the process exits after six opens so the next job starts a fresh worker. The Rust owner also stops its workers on exit and kills timed-out jobs. This limits retained views, but it is not a complete private-host lifecycle or memory-budget implementation.

## Transaction and persistence rules

1. Capture the shared project revision and selected native document.
2. Validate operation type, layer identity, ranges, pressure/coordinates, source formats, canvas bounds, and locks. Reject empty-area selections.
3. Run the job against an immutable input file. Produce a new native revision under a unique local directory.
4. Commit the resulting descriptor only if the shared project revision still matches. Publish the snapshot to every window.
5. Undo/redo changes the authoritative native revision pointer and matching preview/layers together. Failed or stale work cannot overwrite the active file.

AI returns an operation proposal through the existing Codex App Server connection. Preview executes the same adapter on a new uncommitted revision. Apply reruns the reviewed operation set against the same checked base revision and commits one history step. Unsupported image synthesis is reported explicitly. Image-generation service integration is separate.

Project schema 7 includes raster documents (added in schema 4), spatial documents (5), developed photographs (6), and saved workflows (7). Schemas 1–6 migrate without changing earlier photo/scene content. Project Save copies active native files, originals, and XMP sidecars into a neighboring `.workshop-assets` directory and writes relative references. Open resolves and checks them. Recovery retains absolute internal revision paths. Originals opened from disk are never the job's output target.

Native files keep full resolution and native structure. Reduced previews and selection masks are display data. OpenRaster handoffs create a separate document and disclose conversion limitations before the action. Native XCF/KRA files remain the fidelity boundary.

## Remaining engineering work

- High-resolution tiles, asynchronous stroke streaming, native tablet events, and performance profiling on large documents.
- Wider operation coverage: text/vector tools, filter properties, richer group nesting, brush configuration, color management and profiles.
- Better private Krita hosting alongside an existing standalone instance, with separately isolated preferences/resources. The present extension is narrowly enabled in the user's Krita profile.
- Disk-budgeted revision cache compaction, cancellation, and restart-safe undo history.
- Document-close/remove controls and larger portable project containers.
- Expand the native operation sets in each workspace without forcing CAD solids, scene meshes, and photograph recipes into a raster-layer contract.

## Primary API references

- [GIMP 3 API](https://developer.gimp.org/api/3.0/) and [batch procedures](https://developer.gimp.org/api/3.0/libgimp/class.BatchProcedure.html)
- [GIMP native brush operation](https://developer.gimp.org/api/3.0/libgimp/func.paintbrush_default.html)
- [Krita Python scripting](https://docs.krita.org/en/user_manual/python_scripting.html)
- [Krita Node API source](https://github.com/KDE/krita/blob/master/libs/libkis/Node.h) and [View API source](https://github.com/KDE/krita/blob/master/libs/libkis/View.h)

The installed versions' runtime signatures were checked during implementation. Current master documentation can differ from released bindings (for example, `QPoint` versus `QPointF` in `paintLine`).


## Scene and CAD

`SpatialEditor` shares document tabs, command bar, object list/properties, Astra review, status, and detached-window conventions across Blender and FreeCAD. `spatial.rs` coordinates isolated worker jobs. Native FCStd or BLEND revisions are authoritative; evaluated world-space triangles and metadata provide the Three.js viewport. Camera orbit/wireframe interaction stays in the UI while Blender renders a frozen native revision in another process. Render results carry the source document version and are marked stale after edits.

FreeCAD runs `freecadcmd` with the `Part` API. Primitive dimensions and placements remain parametric, and boolean features retain Base/Tool dependencies. STEP exports retain solid geometry; STL is a mesh derivative. Native shape validity and volume are returned with the preview. The current common controls do not expose sketch constraints or the complete feature tree.

Blender runs with `--background --disable-autoexec`, opens BLEND files without loading their UI or scripts, and uses its mesh/material/import/export/render APIs. Native files preserve the rest of the document, although the suite currently exposes only mesh objects and a small operation set. The automatic render camera frames small CAD parts as well as larger models; existing native cameras are retained. Unit conversion is explicit for CAD-to-Scene copies. The procedural coastal-study conversion maps its real-time light values to native sun/sky lighting and retains its exported camera.

The private workers have bounded timeouts. UI rendering does not depend on embedding an external engine window. CAD and Blender documents remain distinct within the shared project and history.

## Native photograph development and library

`DevelopEditor` provides Develop and Library. `develop.rs` keeps an immutable original, native XMP recipe, engine-rendered preview, and project catalog metadata. It invokes `darktable-cli` with private config/cache locations and disables source-sidecar writes. Exposure, contrast, saturation, and black are serialized using the installed release's `basicadj` version 2 structure. This is a constrained native module integration, not an implementation of darktable's full editor or database.

Preview renders all selected photographs before publication. An opaque preview identity records the precise output descriptors and base project revision. Apply commits those reviewed descriptors together without a second render; stale previews are rejected. Rating/tag changes use the same shared project history and do not rewrite originals. Export renders full-size 8-bit PNGs and writes XMP plus `catalog.json`; ratings/tags currently live in the project/catalog, not native XMP metadata.

Portable save copies originals and recipes with stable filenames. Develop-to-Edit renders a new full-resolution image and asks the GIMP adapter to create an XCF copy. The developed photograph remains separate.

## Workflow studio

`WorkflowEditor` composes the same native proposal/edit endpoints as the workspaces. Inputs are raster documents, model documents, individual developed photos, or all developed photos. The transform node accepts an Astra instruction or a validated JSON operation script. The review node displays actual native output and applies against the captured base revision. No arbitrary Python or shell script is accepted.

Recipes store document/layer/object identities, mode, instruction or operations, and node positions inside the project. A missing saved document is not silently substituted with another document. The current graph has three movable nodes and fixed connections; branching/general node authoring remains future work.

Additional primary references: [FreeCAD startup and CLI configuration](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Start_up_and_Configuration.md), [darktable CLI](https://docs.darktable.org/usermanual/4.2/en/special-topics/program-invocation/darktable-cli/), and [the pinned native basic-adjustments module](https://github.com/darktable-org/darktable/blob/release-5.6.1/src/iop/basicadj.c).
