use crate::{
    document::{Project, Snapshot},
    executable, publish, Reply, Studio,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SpatialObject {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub visible: bool,
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub dimensions: BTreeMap<String, f64>,
    pub color: String,
    pub volume: Option<f64>,
    pub valid: bool,
    pub vertices: Arc<Vec<f32>>,
    pub triangles: Arc<Vec<u32>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SpatialDocument {
    pub id: String,
    pub engine: String,
    pub version: String,
    pub name: String,
    pub file: String,
    pub unit: String,
    pub engine_version: String,
    pub objects: Vec<SpatialObject>,
    pub selected: Option<String>,
}
#[derive(Default)]
pub struct SpatialRuntime(pub tokio::sync::Mutex<()>);

pub fn extension(engine: &str) -> Reply<&'static str> {
    match engine {
        "FreeCAD" => Ok("FCStd"),
        "Blender" => Ok("blend"),
        _ => Err("Choose CAD or Scene".into()),
    }
}
fn color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn validate(docs: &[SpatialDocument]) -> Reply<()> {
    if docs.len() > 16 {
        return Err("Use up to 16 CAD and scene documents per project".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut elements = 0;
    for d in docs {
        extension(&d.engine)?;
        if d.objects.len() > 256 {
            return Err("This build supports up to 256 objects per model document".into());
        }
        if uuid::Uuid::parse_str(&d.id).is_err()
            || uuid::Uuid::parse_str(&d.version).is_err()
            || !ids.insert(&d.id)
            || d.name.len() > 200
            || d.file.len() > 4096
        {
            return Err("Invalid spatial document".into());
        }
        let mut objects = std::collections::HashSet::new();
        for o in &d.objects {
            elements += o.vertices.len() + o.triangles.len();
            if o.id.is_empty()
                || !objects.insert(&o.id)
                || o.name.len() > 200
                || !color(&o.color)
                || o.vertices.len() % 3 != 0
                || o.triangles.len() % 3 != 0
                || o.vertices.iter().any(|v| !v.is_finite())
                || o.triangles
                    .iter()
                    .any(|i| *i as usize >= o.vertices.len() / 3)
                || o.position
                    .iter()
                    .chain(o.rotation.iter())
                    .chain(o.dimensions.values())
                    .any(|n| !n.is_finite())
                || o.volume.is_some_and(|n| !n.is_finite())
            {
                return Err("Invalid geometry returned by the engine".into());
            }
        }
    }
    if elements > 6_000_000 {
        return Err("The project has reached its geometry preview limit".into());
    }
    Ok(())
}
fn validate_ops(ops: &[Value], d: &SpatialDocument) -> Reply<()> {
    if ops.is_empty() || ops.len() > 20 {
        return Err("Choose 1–20 supported operations".into());
    }
    for op in ops {
        let kind = op["kind"].as_str().ok_or("Missing operation")?;
        if kind == "add" {
            if !matches!(op["shape"].as_str(), Some("box" | "cylinder" | "sphere")) {
                return Err("Choose a box, cylinder, or sphere".into());
            }
            continue;
        }
        let obj = d
            .objects
            .iter()
            .find(|o| Some(o.id.as_str()) == op["object"].as_str())
            .ok_or("Choose an existing object")?;
        match kind {
            "dimensions" => {
                let values = op["values"].as_object().ok_or("Choose dimensions")?;
                if values.is_empty()
                    || values.iter().any(|(k, v)| {
                        !obj.dimensions.contains_key(k)
                            || !v
                                .as_f64()
                                .is_some_and(|n| n.is_finite() && (0.001..=100_000.).contains(&n))
                    })
                {
                    return Err("Choose supported dimensions from 0.001 to 100,000".into());
                }
            }
            "transform" => {
                for k in ["position", "rotation"] {
                    let v = op[k].as_array().ok_or("Choose three coordinates")?;
                    let limit = if k == "position" { 1_000_000. } else { 36000. };
                    if v.len() != 3
                        || v.iter().any(|n| {
                            !n.as_f64()
                                .is_some_and(|n| n.is_finite() && n.abs() <= limit)
                        })
                    {
                        return Err("Invalid transform".into());
                    }
                }
            }
            "rename" => {
                if !op["name"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
                {
                    return Err("Choose an object name".into());
                }
            }
            "visibility" => {
                if !op["visible"].is_boolean() {
                    return Err("Choose object visibility".into());
                }
            }
            "color" => {
                if d.engine != "Blender" || !op["color"].as_str().is_some_and(color) {
                    return Err("Choose a Blender material color".into());
                }
            }
            "cut" | "union" => {
                if !d
                    .objects
                    .iter()
                    .any(|o| o.id != obj.id && Some(o.id.as_str()) == op["other"].as_str())
                {
                    return Err("Choose a different second object".into());
                }
            }
            "delete" => (),
            _ => return Err("Unsupported spatial operation".into()),
        }
    }
    Ok(())
}
fn snapshot(app: &tauri::AppHandle, base: u64) -> Reply<Snapshot> {
    let s = app
        .state::<Studio>()
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .snapshot();
    if s.revision != base {
        return Err("The project changed in another window. Review the latest version.".into());
    }
    Ok(s)
}
fn document(s: &Snapshot, id: &str) -> Reply<SpatialDocument> {
    s.project
        .spatial_documents
        .iter()
        .find(|d| d.id == id)
        .cloned()
        .ok_or("Choose a CAD or scene document".into())
}
fn commit(
    app: &tauri::AppHandle,
    s: Snapshot,
    doc: SpatialDocument,
    label: &str,
) -> Reply<Snapshot> {
    let mut p = s.project;
    if let Some(d) = p.spatial_documents.iter_mut().find(|d| d.id == doc.id) {
        *d = doc;
    } else {
        p.spatial_documents.push(doc);
    }
    let out = app
        .state::<Studio>()
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .commit(p, s.revision, label.into())?;
    publish(app, &out);
    Ok(out)
}
fn source(engine: &str, path: &Path) -> Reply<()> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let valid = if engine == "FreeCAD" {
        matches!(ext.as_str(), "fcstd" | "step" | "stp" | "brep")
    } else {
        matches!(ext.as_str(), "blend" | "glb" | "gltf" | "stl")
    };
    if !valid || fs::metadata(path).map_err(|e| e.to_string())?.len() > 512_000_000 {
        return Err("Choose a supported model smaller than 512 MB".into());
    }
    Ok(())
}
fn engine_exe(engine: &str) -> Reply<PathBuf> {
    if engine == "FreeCAD" {
        if let Some(p) = std::env::var_os("REALITY_WORKSHOP_FREECAD_CMD") {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Ok(p);
            }
        }
        #[cfg(target_os = "macos")]
        {
            let p = PathBuf::from("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd");
            if p.is_file() {
                return Ok(p);
            }
        }
        if let Some(gui) = executable("FreeCAD") {
            for name in ["FreeCADCmd.exe", "freecadcmd", "FreeCADCmd"] {
                let p = gui.with_file_name(name);
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
        for folder in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
            for name in ["FreeCADCmd", "freecadcmd", "FreeCADCmd.exe"] {
                let p = folder.join(name);
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
        Err("Install FreeCAD with its command-line engine to use CAD".into())
    } else {
        executable(engine).ok_or(format!("Install {engine} to use this workspace"))
    }
}
async fn run(
    app: &tauri::AppHandle,
    engine: &str,
    input: Option<&Path>,
    ops: Vec<Value>,
    export: Option<&Path>,
    render: bool,
) -> Reply<(SpatialDocument, Option<String>)> {
    let runtime = app.state::<SpatialRuntime>();
    let _gate = runtime.0.lock().await;
    let ext = extension(engine)?;
    if let Some(p) = input {
        source(engine, p)?;
    }
    let version = uuid::Uuid::new_v4().to_string();
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("spatial-documents")
        .join(&version);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = folder.join(format!("document.{ext}"));
    let request = folder.join("request.json");
    let response = folder.join("response.json");
    let script = folder.join("worker.py");
    let png = folder.join("render.png");
    fs::write(
        &script,
        if engine == "FreeCAD" {
            include_str!("../workers/engines/freecad_worker.py")
        } else {
            include_str!("../workers/engines/blender_worker.py")
        },
    )
    .map_err(|e| e.to_string())?;
    fs::write(&request,serde_json::to_vec(&json!({"input":input,"output":file,"response":response,"operations":ops,"export":export,"render":if render {Some(&png)}else{None}})).unwrap()).map_err(|e|e.to_string())?;
    let log = fs::File::create(folder.join("engine.log")).map_err(|e| e.to_string())?;
    let mut cmd = tokio::process::Command::new(engine_exe(engine)?);
    if engine == "Blender" {
        cmd.args(["--background", "--disable-autoexec", "--python"])
            .arg(&script);
    } else {
        cmd.arg(&script);
    }
    let child = cmd
        .env("WORKSHOP_SPATIAL_JOB", &request)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output())
        .await
        .map_err(|_| "The engine timed out; your last revision is safe")?
        .map_err(|e| e.to_string())?
        .status;
    if !response.exists() {
        return Err(format!(
            "{engine} did not return a document ({status}). See {}",
            folder.join("engine.log").display()
        ));
    }
    if fs::metadata(&response).map_err(|e| e.to_string())?.len() > 60_000_000 {
        return Err("The model preview is too large".into());
    }
    let result: Value = serde_json::from_slice(&fs::read(response).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if result["ok"] != true {
        return Err(result["error"]
            .as_str()
            .unwrap_or("The engine rejected this operation")
            .into());
    }
    let mut value = result["document"].clone();
    value["id"] = json!(uuid::Uuid::new_v4().to_string());
    value["engine"] = json!(engine);
    value["version"] = json!(version);
    value["name"] = json!("Untitled model");
    value["file"] = json!(file);
    let doc: SpatialDocument = serde_json::from_value(value).map_err(|e| e.to_string())?;
    validate(std::slice::from_ref(&doc))?;
    let image = if render {
        Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(fs::read(png).map_err(|e| e.to_string())?)
        ))
    } else {
        None
    };
    Ok((doc, image))
}
#[tauri::command]
pub async fn spatial_open(
    app: tauri::AppHandle,
    engine: String,
    path: Option<String>,
    base: u64,
) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    let (mut doc, _) = run(
        &app,
        &engine,
        path.as_deref().map(Path::new),
        if path.is_none() {
            vec![json!({"kind":"add","shape":"box"})]
        } else {
            vec![]
        },
        None,
        false,
    )
    .await?;
    doc.name = path
        .as_deref()
        .and_then(|p| Path::new(p).file_stem())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(format!(
            "Untitled {}",
            if engine == "FreeCAD" { "part" } else { "scene" }
        ));
    commit(&app, s, doc, &format!("Open {engine} document"))
}
#[tauri::command]
pub async fn spatial_edit(
    app: tauri::AppHandle,
    id: String,
    operations: Vec<Value>,
    base: u64,
    preview: bool,
) -> Reply<SpatialDocument> {
    let s = snapshot(&app, base)?;
    let old = document(&s, &id)?;
    validate_ops(&operations, &old)?;
    let (mut doc, _) = run(
        &app,
        &old.engine,
        Some(Path::new(&old.file)),
        operations,
        None,
        false,
    )
    .await?;
    doc.id = old.id;
    doc.name = old.name;
    if !preview {
        commit(&app, s, doc.clone(), "Edit model")?;
    }
    Ok(doc)
}
#[tauri::command]
pub async fn spatial_export(
    app: tauri::AppHandle,
    id: String,
    path: String,
    base: u64,
) -> Reply<()> {
    let s = snapshot(&app, base)?;
    let d = document(&s, &id)?;
    let dest = PathBuf::from(path);
    let ext = dest
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !dest.is_absolute() {
        return Err("Choose an export location".into());
    }
    let native = ext == extension(&d.engine)?.to_lowercase();
    if !native
        && !(ext == "stl"
            || (d.engine == "FreeCAD" && matches!(ext.as_str(), "step" | "stp"))
            || (d.engine == "Blender" && ext == "glb"))
    {
        return Err("Choose a supported export format".into());
    }
    let temporary = dest.with_file_name(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    let result = if native {
        fs::copy(&d.file, &temporary)
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        run(
            &app,
            &d.engine,
            Some(Path::new(&d.file)),
            vec![],
            Some(&temporary),
            false,
        )
        .await
        .map(|_| ())
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&temporary);
        return Err(e);
    }
    fs::rename(&temporary, &dest).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn spatial_render(app: tauri::AppHandle, id: String, base: u64) -> Reply<Value> {
    let s = snapshot(&app, base)?;
    let d = document(&s, &id)?;
    if d.engine != "Blender" {
        return Err("Render a Blender scene".into());
    }
    let (_, image) = run(
        &app,
        &d.engine,
        Some(Path::new(&d.file)),
        vec![],
        None,
        true,
    )
    .await?;
    Ok(json!({"image":image,"version":d.version}))
}
#[tauri::command]
pub async fn spatial_propose(
    app: tauri::AppHandle,
    id: String,
    base: u64,
    prompt: String,
    selected: Option<String>,
) -> Reply<Value> {
    if prompt.trim().is_empty() || prompt.len() > 8000 {
        return Err("Describe the change in up to 8,000 characters".into());
    }
    let s = snapshot(&app, base)?;
    let d = document(&s, &id)?;
    let objects:Vec<Value>=d.objects.iter().map(|o|json!({"id":o.id,"name":o.name,"dimensions":o.dimensions,"position":o.position,"rotation":o.rotation,"visible":o.visible})).collect();
    let schema = json!({"type":"object","additionalProperties":false,"required":["summary","supported","operations_json"],"properties":{"summary":{"type":"string"},"supported":{"type":"boolean"},"operations_json":{"type":"string"}}});
    let context = json!({"engine":d.engine,"units":d.unit,"objects":objects,"selected":selected,"request":prompt});
    let v=crate::agent::run_codex(&app,"You are the design partner in a native 3D suite. Propose only requested changes. No tools, code, or file edits. Return operations_json as a JSON array of allowed operations: {kind:'dimensions',object:existingId,values:{existingDimensionName:number}}, {kind:'transform',object:existingId,position:[x,y,z],rotation:[x,y,z] in degrees}, {kind:'rename',object:existingId,name:string}, {kind:'visibility',object:existingId,visible:boolean}, {kind:'add',shape:'box'|'cylinder'|'sphere'}, {kind:'cut'|'union',object:existingId,other:otherExistingId}; Blender only {kind:'color',object:existingId,color:'#rrggbb'}. Keep unrequested values. Dimensions are positive and use the provided document units. Preserve transforms for axes not mentioned. Return supported:false and empty operations for unsupported synthesis, sculpting, image generation, or arbitrary shapes. The user previews and explicitly applies.",schema,vec![json!({"type":"text","text":context.to_string()})]).await?;
    let ops: Vec<Value> = serde_json::from_str(v["operations_json"].as_str().unwrap_or("[]"))
        .map_err(|e| e.to_string())?;
    if v["supported"] == true {
        validate_ops(&ops, &d)?;
    }
    Ok(json!({"summary":v["summary"],"supported":v["supported"],"operations":ops,"base":base}))
}
pub fn portable(project: &mut Project, path: &Path) -> Reply<()> {
    let folder = path.with_extension("workshop-assets");
    for d in &mut project.spatial_documents {
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let target = folder.join(format!("{}.{}", d.version, extension(&d.engine)?));
        source(&d.engine, Path::new(&d.file))?;
        if Path::new(&d.file) != target {
            fs::copy(&d.file, &target).map_err(|e| e.to_string())?;
        }
        d.file = format!(
            "{}/{}",
            folder.file_name().unwrap().to_string_lossy(),
            target.file_name().unwrap().to_string_lossy()
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn spatial_from_study(app: tauri::AppHandle, gltf: String, base: u64) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    if gltf.len() > 40_000_000 {
        return Err("The study is too large to copy".into());
    }
    let _: Value = serde_json::from_str(&gltf).map_err(|e| e.to_string())?;
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("study-copies")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let input = folder.join("Coastal study.gltf");
    fs::write(&input, gltf).map_err(|e| e.to_string())?;
    let (mut doc, _) = run(
        &app,
        "Blender",
        Some(&input),
        vec![json!({"kind":"study_lighting","sun_angle":s.project.scene.sun_angle})],
        None,
        false,
    )
    .await?;
    doc.name = "Coastal study".into();
    commit(&app, s, doc, "Copy coastal study to Blender")
}

#[tauri::command]
pub async fn spatial_transfer(app: tauri::AppHandle, id: String, base: u64) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    let d = document(&s, &id)?;
    if d.engine != "FreeCAD" {
        return Err("Choose a CAD part to copy into Scene".into());
    }
    let temp = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(format!("cad-copy-{}.stl", uuid::Uuid::new_v4()));
    run(
        &app,
        &d.engine,
        Some(Path::new(&d.file)),
        vec![],
        Some(&temp),
        false,
    )
    .await?;
    let result = run(
        &app,
        "Blender",
        Some(&temp),
        vec![json!({"kind":"units_mm_to_m","name":d.name})],
        None,
        false,
    )
    .await;
    let _ = fs::remove_file(temp);
    let (mut target, _) = result?;
    target.name = format!("{} — Scene copy", d.name);
    commit(&app, s, target, "Copy CAD solids to Scene")
}
pub fn resolve(project: &mut Project, path: &Path) -> Reply<()> {
    for d in &mut project.spatial_documents {
        let file = PathBuf::from(&d.file);
        if file
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            return Err("Invalid model path".into());
        }
        let file = if file.is_relative() {
            path.parent().unwrap_or(Path::new(".")).join(file)
        } else {
            file
        };
        source(&d.engine, &file)?;
        d.file = file.to_string_lossy().into();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> SpatialDocument {
        SpatialDocument {
            id: uuid::Uuid::new_v4().to_string(),
            version: uuid::Uuid::new_v4().to_string(),
            engine: "FreeCAD".into(),
            name: "Part".into(),
            file: "part.FCStd".into(),
            unit: "mm".into(),
            engine_version: "test".into(),
            selected: Some("Box".into()),
            objects: vec![SpatialObject {
                id: "Box".into(),
                name: "Box".into(),
                kind: "Part::Box".into(),
                visible: true,
                position: [0.; 3],
                rotation: [0.; 3],
                dimensions: BTreeMap::from([("Length".into(), 40.)]),
                color: "#64b8b0".into(),
                volume: Some(24000.),
                valid: true,
                vertices: Arc::new(vec![0., 0., 0., 1., 0., 0., 0., 1., 0.]),
                triangles: Arc::new(vec![0, 1, 2]),
            }],
        }
    }
    #[test]
    fn invalid_geometry_and_unsupported_operations_are_rejected() {
        let mut doc = fixture();
        validate(std::slice::from_ref(&doc)).unwrap();
        for op in [
            json!({"kind":"execute","object":"Box","code":"x"}),
            json!({"kind":"dimensions","object":"Box","values":{"Length":-2}}),
            json!({"kind":"dimensions","object":"Box","values":{"Radius":2}}),
            json!({"kind":"cut","object":"Box","other":"Box"}),
            json!({"kind":"transform","object":"Box","position":[0,0],"rotation":[0,0,0]}),
        ] {
            assert!(validate_ops(&[op], &doc).is_err());
        }
        doc.objects[0].triangles = Arc::new(vec![0, 1, 99]);
        assert!(validate(&[doc]).is_err());
    }
    #[test]
    fn native_geometry_and_parameters_move_together_through_undo() {
        let mut state = crate::document::Document::default();
        let mut p = state.project.clone();
        let original = fixture();
        p.spatial_documents.push(original.clone());
        state.commit(p.clone(), 0, "Open".into()).unwrap();
        p.spatial_documents[0].file = "changed.FCStd".into();
        p.spatial_documents[0].objects[0]
            .dimensions
            .insert("Length".into(), 60.);
        state.commit(p.clone(), 1, "Resize".into()).unwrap();
        assert!(state.commit(p.clone(), 1, "Stale".into()).is_err());
        assert_eq!(state.undo().project.spatial_documents[0], original);
        assert_eq!(
            state.redo().project.spatial_documents[0],
            p.spatial_documents[0]
        );
    }
    #[test]
    fn saved_models_reopen_after_project_folder_moves() {
        let root = std::env::temp_dir().join(format!("spatial-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("old")).unwrap();
        let mut p = Project::default();
        let mut doc = fixture();
        let source = root.join("cached.FCStd");
        fs::write(&source, b"native fixture").unwrap();
        doc.file = source.to_string_lossy().into();
        p.spatial_documents.push(doc);
        portable(&mut p, &root.join("old/project.workshop")).unwrap();
        fs::rename(root.join("old"), root.join("new")).unwrap();
        fs::remove_file(source).unwrap();
        resolve(&mut p, &root.join("new/project.workshop")).unwrap();
        assert_eq!(
            fs::read(&p.spatial_documents[0].file).unwrap(),
            b"native fixture"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
