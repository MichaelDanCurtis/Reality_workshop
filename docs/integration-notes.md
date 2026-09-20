# Integration direction — 2026-09-19

This is an initial feasibility map, not verified round-trip support. Begin with explicit adapters and preserved native files; selectively embed or extend engines after exercising their real editing APIs. A scripting interface does not automatically provide an embeddable UI or complete feature access.

The [Design Review Package plan](design-review-plan.md) defines optional review across workspaces, independent model and effort settings per feature, usage controls, and a later local-model option.

| Product | Intended contribution | Initial interface | Native source to retain |
| --- | --- | --- | --- |
| GIMP | Layered raster compositing and image operations | GIMP 3 plug-ins and GEGL | XCF |
| Krita | Painting, illustration, brush workflows | Python extension and document interface; core work for deeper brush integration | KRA |
| darktable | Library, RAW development, color workflow | Lua, styles and export; test exact development controls | Originals plus development metadata |
| Blender | Modeling, materials, cameras, rendering | Python and background processes | BLEND |
| FreeCAD | Dimensioned solids and parametric history | Python and document API | FCStd |
| Workshop Workflows | User-owned nodes, scripts and AI operations | Same typed command boundary as manual tools | Versioned workflow graph |

## Shared editing model

Keep engine-native source assets and explicit import/export derivatives. Do not promise universal lossless conversion. Track coordinate system, units, color profile, document revision, source hash and conversion settings. CAD solids remain authoritative for dimensions; tessellation is a view/export derivative.

The agent receives the selected object, active workspace, relevant references and allowed operations. It returns structured proposals which are validated before preview or application. Natural language, visual nodes and direct manipulation must converge on the same operations. AI generation provider access is separately configured from subscription-authenticated Codex orchestration.

## Multi-window behavior

- Workspace windows are views over one shared project, not copies of it.
- Geometry stays interactive while a worker renders a frozen revision.
- Linked cameras are optional. Independent camera views must not fight each other.
- Every render displays the revision it represents and a stale marker when the project changes.
- Window positions, size and workspace restore sensibly when a monitor is unplugged.
- A queued render can be superseded; a failed render preserves the previous completed image.

## Sources

- https://developer.gimp.org/resource/api/
- https://docs.krita.org/en/user_manual/python_scripting.html
- https://docs.darktable.org/lua/stable/
- https://docs.blender.org/api/5.1/info_overview.html
- https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FreeCAD_Scripting_Basics.md
- https://developer.apple.com/augmented-reality/roomplan/
- https://developer.apple.com/videos/play/wwdc2023/10191/
