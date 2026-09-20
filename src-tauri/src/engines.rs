//! Native engine documents. Immutable XCF/KRA revisions are the source of truth;
//! previews never replace the native file. Commands and AI use the same adapter.
use crate::{
    document::{Project, Snapshot},
    executable, publish, Studio,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;

type Reply<T> = Result<T, String>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NativeDocument {
    pub id: String,
    pub engine: String,
    pub version: String,
    pub name: String,
    pub file: String,
    pub preview: Arc<str>,
    pub width: u32,
    pub height: u32,
    pub layers: Vec<Layer>,
    pub selected: Option<String>,
    pub selection: bool,
    #[serde(default)]
    pub selection_preview: Option<Arc<str>>,
    pub engine_version: String,
    pub presets: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Layer {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub visible: bool,
    pub opacity: f64,
    pub mode: String,
    pub depth: u32,
    pub mask: bool,
    pub locked: bool,
}
#[derive(Default)]
pub struct EngineRuntime {
    gate: tokio::sync::Mutex<()>,
    krita: Mutex<Option<KritaWorker>>,
    gimp: Mutex<Option<KritaWorker>>,
}
struct KritaWorker {
    child: std::process::Child,
    queue: PathBuf,
}
impl Drop for KritaWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn shutdown(app: &tauri::AppHandle) {
    if let Ok(mut worker) = app.state::<EngineRuntime>().gimp.lock() {
        *worker = None;
    }
    if let Ok(mut worker) = app.state::<EngineRuntime>().krita.lock() {
        *worker = None;
    }
}
fn extension(engine: &str) -> Reply<&'static str> {
    match engine {
        "GIMP" => Ok("xcf"),
        "Krita" => Ok("kra"),
        _ => Err("Unknown document engine".into()),
    }
}
pub fn validate_documents(docs: &[NativeDocument]) -> Reply<()> {
    if docs.len() > 32 {
        return Err("Use up to 32 native documents per project".into());
    }
    let mut ids = std::collections::HashSet::new();
    for d in docs {
        let ext = extension(&d.engine)?;
        if !ids.insert(&d.id)
            || uuid::Uuid::parse_str(&d.id).is_err()
            || uuid::Uuid::parse_str(&d.version).is_err()
            || d.width == 0
            || d.height == 0
            || u64::from(d.width) * u64::from(d.height) > 40_000_000
            || d.layers.len() > 1000
            || d.preview.len() > 8_000_000
            || !d.preview.starts_with("data:image/png;base64,")
            || Path::new(&d.file).extension().and_then(|e| e.to_str()) != Some(ext)
            || d.name.len() > 512
            || d.presets.len() > 5000
            || d.layers.iter().any(|l| {
                !l.opacity.is_finite() || !(0.0..=100.0).contains(&l.opacity) || l.depth > 100
            })
        {
            return Err("Invalid native document".into());
        }
    }
    Ok(())
}
fn source(path: &Path) -> Reply<()> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ![
        "xcf", "kra", "ora", "psd", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp",
    ]
    .contains(&ext.as_str())
    {
        return Err("Choose a native document or a supported image".into());
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 512_000_000 {
        return Err("Choose a document smaller than 512 MB".into());
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
        return Err("The project changed. Review the latest version and try again.".into());
    }
    Ok(s)
}
fn document(s: &Snapshot, id: &str) -> Reply<NativeDocument> {
    s.project
        .native_documents
        .iter()
        .find(|d| d.id == id)
        .cloned()
        .ok_or("Choose an existing engine document".into())
}
fn commit_native(
    app: &tauri::AppHandle,
    s: Snapshot,
    doc: NativeDocument,
    label: &str,
) -> Reply<Snapshot> {
    let mut p = s.project;
    if let Some(old) = p.native_documents.iter_mut().find(|d| d.id == doc.id) {
        *old = doc;
    } else {
        p.native_documents.push(doc);
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
fn validate_operations(ops: &[Value], doc: &NativeDocument) -> Reply<()> {
    if ops.is_empty() || ops.len() > 40 {
        return Err("Choose between 1 and 40 operations".into());
    }
    for op in ops {
        let kind = op["kind"].as_str().ok_or("Missing operation")?;
        let number = |key: &str, lo: f64, hi: f64| -> Reply<()> {
            match op[key].as_f64() {
                Some(n) if n.is_finite() && (lo..=hi).contains(&n) => Ok(()),
                _ => Err(format!("Invalid {key}")),
            }
        };
        if ![
            "add_layer",
            "add_group",
            "select",
            "clear_selection",
            "crop",
            "rotate",
            "import_layer",
        ]
        .contains(&kind)
        {
            let l = doc
                .layers
                .iter()
                .find(|l| Some(l.id.as_str()) == op["layer"].as_str())
                .ok_or("Choose an existing layer")?;
            if l.locked
                && [
                    "stroke",
                    "fill",
                    "invert",
                    "desaturate",
                    "brightness_contrast",
                    "move",
                    "delete",
                ]
                .contains(&kind)
            {
                return Err("This layer is locked in the native document".into());
            }
            if kind == "delete" && doc.layers.len() == 1 {
                return Err("Keep at least one layer".into());
            }
        }
        match kind {
            "add_layer" | "add_group" | "rename" => {
                if !op["name"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
                {
                    return Err("Enter a layer name up to 200 characters".into());
                }
            }
            "visibility" => {
                if !op["visible"].is_boolean() {
                    return Err("Invalid layer visibility".into());
                }
            }
            "opacity" => number("value", 0., 100.)?,
            "blend" => {
                if ![
                    Some("normal"),
                    Some("multiply"),
                    Some("screen"),
                    Some("overlay"),
                ]
                .contains(&op["mode"].as_str())
                {
                    return Err("Unsupported blend mode".into());
                }
            }
            "reorder" => {
                if op["direction"] != -1 && op["direction"] != 1 {
                    return Err("Invalid layer order".into());
                }
            }
            "move" => {
                number("dx", -40000., 40000.)?;
                number("dy", -40000., 40000.)?;
            }
            "stroke" | "select" => {
                let points = op["points"]
                    .as_array()
                    .ok_or("Draw a stroke or selection")?;
                if points.len() < if kind == "select" { 3 } else { 1 } || points.len() > 4096 {
                    return Err("Invalid stroke length".into());
                }
                for p in points {
                    for k in ["x", "y", "pressure"] {
                        if !p[k]
                            .as_f64()
                            .is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v))
                        {
                            return Err("Invalid stroke coordinate".into());
                        }
                    }
                }
                if kind == "select" {
                    let twice_area: f64 = points
                        .iter()
                        .zip(points.iter().cycle().skip(1))
                        .map(|(a, b)| {
                            a["x"].as_f64().unwrap() * b["y"].as_f64().unwrap()
                                - b["x"].as_f64().unwrap() * a["y"].as_f64().unwrap()
                        })
                        .sum();
                    if twice_area.abs() * f64::from(doc.width) * f64::from(doc.height) < 2.0 {
                        return Err("Draw a region with an area of at least one pixel".into());
                    }
                }
                if kind == "stroke" {
                    number("size", 1., 1000.)?;
                    number("opacity", 0., 100.)?;
                    if let Some(preset) = op["preset"].as_str() {
                        if !doc.presets.iter().any(|p| p == preset) {
                            return Err("Unknown brush preset".into());
                        }
                    }
                    if op["target"] == "mask"
                        && !doc
                            .layers
                            .iter()
                            .any(|l| Some(l.id.as_str()) == op["layer"].as_str() && l.mask)
                    {
                        return Err("Add a mask before painting it".into());
                    }
                }
            }
            "brightness_contrast" => {
                if doc.engine != "GIMP" {
                    return Err("This adjustment belongs to the GIMP workspace".into());
                }
                number("brightness", -1., 1.)?;
                number("contrast", -1., 1.)?;
            }
            "crop" => {
                number("x", 0., f64::from(doc.width) - 1.)?;
                number("y", 0., f64::from(doc.height) - 1.)?;
                number(
                    "width",
                    1.,
                    f64::from(doc.width) - op["x"].as_f64().unwrap(),
                )?;
                number(
                    "height",
                    1.,
                    f64::from(doc.height) - op["y"].as_f64().unwrap(),
                )?;
            }
            "import_layer" => source(Path::new(
                op["path"].as_str().ok_or("Choose a layer image")?,
            ))?,
            "fill" | "duplicate" | "delete" | "mask" | "remove_mask" | "clear_selection"
            | "invert" | "desaturate" | "rotate" => {}
            _ => return Err("Unsupported native operation".into()),
        }
        if (kind == "stroke" || kind == "fill")
            && !op["color"].as_str().is_some_and(|s| {
                s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("Choose a valid brush color".into());
        }
    }
    Ok(())
}
fn install_krita_bridge(app: &tauri::AppHandle) -> Reply<()> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| e.to_string())?
        .join("krita/pykrita");
    let folder = base.join("workshopbridge");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    fs::write(
        folder.join("__init__.py"),
        include_str!("../workers/engines/krita_bridge.py"),
    )
    .map_err(|e| e.to_string())?;
    fs::write(base.join("workshopbridge.desktop"), "[Desktop Entry]\nType=Service\nServiceTypes=Krita/PythonPlugin\nX-KDE-Library=workshopbridge\nName=Reality Workshop bridge\nComment=Native painting worker for Reality Workshop\n").map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let config = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join("Library/Preferences/kritarc");
    #[cfg(target_os = "windows")]
    let config =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Cannot locate Krita preferences")?)
            .join("kritarc");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let config = app
        .path()
        .config_dir()
        .map_err(|e| e.to_string())?
        .join("kritarc");
    let mut text = fs::read_to_string(&config).unwrap_or_default();
    if !text
        .lines()
        .any(|l| l.trim() == "enable_workshopbridge=true")
    {
        text = text
            .lines()
            .filter(|l| !l.trim().starts_with("enable_workshopbridge="))
            .collect::<Vec<_>>()
            .join("\n");
        text.push_str("\n[python]\nenable_workshopbridge=true\n");
        if let Some(parent) = config.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&config, text).map_err(|e| e.to_string())?;
    }
    Ok(())
}
async fn execute(app: &tauri::AppHandle, engine: &str, job: &Value, folder: &Path) -> Reply<Value> {
    let runtime = app.state::<EngineRuntime>();
    let _guard = runtime.gate.lock().await;
    let exe = executable(engine).ok_or(format!("Install {engine} to open this workspace"))?;
    let request = folder.join("request.json");
    let response = PathBuf::from(job["response"].as_str().unwrap());
    fs::write(&request, serde_json::to_vec(job).unwrap()).map_err(|e| e.to_string())?;
    let slot = if engine == "GIMP" {
        &runtime.gimp
    } else {
        &runtime.krita
    };
    let queue = {
        let mut worker = slot.lock().map_err(|e| e.to_string())?;
        if worker
            .as_mut()
            .is_some_and(|w| w.child.try_wait().ok().flatten().is_some())
        {
            *worker = None;
        }
        if worker.is_none() {
            let queue = folder.join("queue");
            fs::create_dir_all(&queue).map_err(|e| e.to_string())?;
            let log = fs::File::create(folder.join("engine.log")).map_err(|e| e.to_string())?;
            let mut cmd = std::process::Command::new(exe);
            if engine == "GIMP" {
                let script = folder.join("worker.py");
                fs::write(&script, include_str!("../workers/engines/gimp_worker.py"))
                    .map_err(|e| e.to_string())?;
                cmd.args(["-n","-i","-s","--console-messages","--batch-interpreter=python-fu-eval","-b","import os; exec(compile(open(os.environ['WORKSHOP_ENGINE_SCRIPT']).read(), 'workshop-worker', 'exec'))","--quit"])
                    .env("WORKSHOP_ENGINE_SCRIPT", &script);
            } else {
                install_krita_bridge(app)?;
                cmd.arg("--nosplash");
            }
            let child = cmd
                .env("WORKSHOP_ENGINE_QUEUE", &queue)
                .stdin(Stdio::null())
                .stdout(log.try_clone().map_err(|e| e.to_string())?)
                .stderr(log)
                .spawn()
                .map_err(|e| e.to_string())?;
            *worker = Some(KritaWorker { child, queue });
        }
        worker.as_ref().unwrap().queue.clone()
    };
    let pending = queue.join(format!("{}.request.json", uuid::Uuid::new_v4()));
    let temp = pending.with_extension("tmp");
    fs::copy(&request, &temp).map_err(|e| e.to_string())?;
    fs::rename(&temp, &pending).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    while !response.exists() {
        if std::time::Instant::now() > deadline {
            *slot.lock().map_err(|e| e.to_string())? = None;
            return Err(format!(
                "{engine} did not finish within two minutes. The last document revision is safe."
            ));
        }
        if slot
            .lock()
            .map_err(|e| e.to_string())?
            .as_mut()
            .is_some_and(|w| w.child.try_wait().ok().flatten().is_some())
        {
            return Err(format!("{engine} could not start its worker. Close an already-running {engine} window and retry. Your document is unchanged. Details: {}", folder.join("engine.log").display()));
        }
        tokio::time::sleep(Duration::from_millis(35)).await;
    }
    let result: Value = serde_json::from_slice(&fs::read(response).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if result["ok"] != true {
        return Err(result["error"]
            .as_str()
            .unwrap_or("The engine rejected the operation")
            .into());
    }
    Ok(result["document"].clone())
}
async fn render_job(
    app: &tauri::AppHandle,
    engine: &str,
    input: Option<&Path>,
    size: (u32, u32),
    ops: Vec<Value>,
    export: Option<&Path>,
) -> Reply<NativeDocument> {
    let ext = extension(engine)?;
    if let Some(p) = input {
        source(p)?;
    }
    if size.0 == 0 || size.1 == 0 || u64::from(size.0) * u64::from(size.1) > 40_000_000 {
        return Err("Choose a canvas up to 40 megapixels".into());
    }
    let version = uuid::Uuid::new_v4().to_string();
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("native-documents")
        .join(&version);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let output = folder.join(format!("document.{ext}"));
    let preview = folder.join("preview.png");
    let job = json!({"input":input,"output":output,"preview":preview,"response":folder.join("response.json"),"width":size.0,"height":size.1,"operations":ops,"export":export});
    let meta = execute(app, engine, &job, &folder).await?;
    let mut value = meta;
    for (k, v) in [
        ("id", json!(uuid::Uuid::new_v4().to_string())),
        ("engine", json!(engine)),
        ("version", json!(version)),
        ("name", json!("Untitled")),
        ("file", json!(output)),
        (
            "preview",
            json!(format!(
                "data:image/png;base64,{}",
                STANDARD.encode(fs::read(preview).map_err(|e| e.to_string())?)
            )),
        ),
    ] {
        value[k] = v;
    }
    let doc: NativeDocument = serde_json::from_value(value).map_err(|e| e.to_string())?;
    validate_documents(std::slice::from_ref(&doc))?;
    Ok(doc)
}
#[tauri::command]
pub async fn engine_open(
    app: tauri::AppHandle,
    engine: String,
    path: Option<String>,
    asset_id: Option<String>,
    width: u32,
    height: u32,
    base: u64,
) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    let imported = if let Some(id) = asset_id {
        let a = s
            .project
            .assets
            .iter()
            .find(|a| a.id == id)
            .ok_or("Choose a project photograph")?;
        let (prefix, encoded) = a.data_url.split_once(',').ok_or("Invalid image")?;
        let ext = if prefix.contains("jpeg") {
            "jpg"
        } else if prefix.contains("webp") {
            "webp"
        } else {
            "png"
        };
        let folder = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("native-imports");
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let file = folder.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
        fs::write(&file, STANDARD.decode(encoded).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Some((file, a.name.clone()))
    } else {
        None
    };
    let input = imported
        .as_ref()
        .map(|(p, _)| p.as_path())
        .or(path.as_deref().map(Path::new));
    let mut doc = render_job(&app, &engine, input, (width, height), vec![], None).await?;
    doc.name = path
        .as_deref()
        .and_then(|p| Path::new(p).file_stem())
        .map(|s| s.to_string_lossy().into())
        .unwrap_or(format!(
            "Untitled {}",
            if engine == "GIMP" {
                "composition"
            } else {
                "painting"
            }
        ));
    if let Some((_, name)) = imported {
        doc.name = name;
    }
    commit_native(&app, s, doc, &format!("Open {engine} document"))
}
#[tauri::command]
pub async fn engine_edit(
    app: tauri::AppHandle,
    id: String,
    operations: Vec<Value>,
    base: u64,
    label: String,
    preview: bool,
) -> Reply<NativeDocument> {
    let s = snapshot(&app, base)?;
    let old = document(&s, &id)?;
    validate_operations(&operations, &old)?;
    let mut doc = render_job(
        &app,
        &old.engine,
        Some(Path::new(&old.file)),
        (old.width, old.height),
        operations,
        None,
    )
    .await?;
    doc.id = old.id;
    doc.name = old.name;
    if !preview {
        commit_native(
            &app,
            s,
            doc.clone(),
            &label.chars().take(200).collect::<String>(),
        )?;
    }
    Ok(doc)
}
#[tauri::command]
pub async fn engine_export(
    app: tauri::AppHandle,
    id: String,
    path: String,
    base: u64,
) -> Reply<()> {
    let s = snapshot(&app, base)?;
    let doc = document(&s, &id)?;
    let target = Path::new(&path);
    let ext = target
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == extension(&doc.engine)? {
        let tmp = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::copy(&doc.file, &tmp).map_err(|e| e.to_string())?;
        fs::rename(&tmp, target).map_err(|e| e.to_string())?;
    } else if ext == "png" || ext == "ora" {
        let temp = target.with_file_name(format!(".workshop-{}.{}", uuid::Uuid::new_v4(), ext));
        render_job(
            &app,
            &doc.engine,
            Some(Path::new(&doc.file)),
            (doc.width, doc.height),
            vec![],
            Some(&temp),
        )
        .await?;
        fs::rename(&temp, target).map_err(|e| e.to_string())?;
    } else {
        return Err("Export a native document, PNG, or OpenRaster file".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn engine_transfer(app: tauri::AppHandle, id: String, base: u64) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    let old = document(&s, &id)?;
    let dest = if old.engine == "GIMP" {
        "Krita"
    } else {
        "GIMP"
    };
    let transfer = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(format!("transfer-{}.ora", uuid::Uuid::new_v4()));
    render_job(
        &app,
        &old.engine,
        Some(Path::new(&old.file)),
        (old.width, old.height),
        vec![],
        Some(&transfer),
    )
    .await?;
    let result = render_job(
        &app,
        dest,
        Some(&transfer),
        (old.width, old.height),
        vec![],
        None,
    )
    .await;
    let _ = fs::remove_file(&transfer);
    let mut doc = result?;
    doc.name = format!(
        "{} — {} copy",
        old.name,
        if dest == "Krita" { "Paint" } else { "Edit" }
    );
    commit_native(&app, s, doc, &format!("Copy layers to {dest}"))
}
/// Copy native revisions alongside the manifest. The saved project can be moved
/// together with its .workshop-assets directory, without referencing our cache.
pub fn portable_project(project: &Project, path: &Path) -> Reply<Project> {
    let mut p = project.clone();
    crate::spatial::portable(&mut p, path)?;
    crate::develop::portable(&mut p, path)?;
    if p.native_documents.is_empty() {
        return Ok(p);
    }
    let assets = path.with_extension("workshop-assets");
    fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    for doc in &mut p.native_documents {
        let filename = format!("{}.{}", doc.version, extension(&doc.engine)?);
        let dest = assets.join(&filename);
        if !dest.exists() {
            let tmp = assets.join(format!("{}.tmp", uuid::Uuid::new_v4()));
            fs::copy(&doc.file, &tmp)
                .map_err(|e| format!("Could not include native document: {e}"))?;
            fs::rename(tmp, &dest).map_err(|e| e.to_string())?;
        }
        doc.file = Path::new(assets.file_name().ok_or("Choose a project filename")?)
            .join(filename)
            .to_string_lossy()
            .into();
    }
    Ok(p)
}
pub fn resolve_project(project: &mut Project, path: &Path) -> Reply<()> {
    crate::spatial::resolve(project, path)?;
    crate::develop::resolve(project, path)?;
    for doc in &mut project.native_documents {
        let p = Path::new(&doc.file);
        if p.is_relative() {
            if p.components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err("Invalid native document path in project".into());
            }
            doc.file = path
                .parent()
                .unwrap_or(Path::new("."))
                .join(p)
                .to_string_lossy()
                .into();
        }
        source(Path::new(&doc.file))?;
    }
    Ok(())
}
#[derive(Serialize)]
pub struct EngineProposal {
    summary: String,
    supported: bool,
    operations: Vec<Value>,
    base: u64,
    id: String,
}
#[tauri::command]
pub async fn engine_propose(
    app: tauri::AppHandle,
    id: String,
    base: u64,
    prompt: String,
    layer: String,
) -> Reply<EngineProposal> {
    if prompt.trim().is_empty() || prompt.len() > 8000 {
        return Err("Describe the change in up to 8,000 characters".into());
    }
    let s = snapshot(&app, base)?;
    let doc = document(&s, &id)?;
    if !doc.layers.iter().any(|l| l.id == layer) {
        return Err("Choose a layer".into());
    }
    let schema = json!({"type":"object","additionalProperties":false,"required":["summary","supported","operations_json"],"properties":{"summary":{"type":"string"},"supported":{"type":"boolean"},"operations_json":{"type":"string"}}});
    let context = format!(
        "Engine: {}. Selected layer: {}. Layers: {}. Request: {}",
        doc.engine,
        layer,
        serde_json::to_string(&doc.layers).unwrap(),
        prompt
    );
    let value=crate::agent::run_codex(&app,"You are the design partner inside a native layered creative suite. Propose precise changes only using the allowed operations below. Return operations_json as a JSON array. Do not call tools or write files. Preserve unrequested layers. Allowed: {kind:'rename',layer:existingId,name:string}, {kind:'opacity',layer:existingId,value:0..100}, {kind:'visibility',layer:existingId,visible:boolean}, {kind:'blend',layer:existingId,mode:'normal'|'multiply'|'screen'|'overlay'}, {kind:'duplicate',layer:existingId}, {kind:'add_layer',name:string}, {kind:'add_group',name:string}, {kind:'invert',layer:existingId}, {kind:'desaturate',layer:existingId}, GIMP only {kind:'brightness_contrast',layer:existingId,brightness:-1..1,contrast:-1..1}. Never claim to generate or replace image objects; those require an image generation connection which is not yet enabled. If any requested change is unsupported return supported:false and operations_json:'[]' with an explanation. The user must preview and explicitly apply. Use actual double-quoted JSON in operations_json.",schema,vec![json!({"type":"text","text":context}),json!({"type":"image","url":doc.preview})]).await?;
    let supported = value["supported"].as_bool().unwrap_or(false);
    let ops: Vec<Value> = serde_json::from_str(value["operations_json"].as_str().unwrap_or("[]"))
        .map_err(|e| e.to_string())?;
    if supported {
        validate_operations(&ops, &doc)?;
    }
    Ok(EngineProposal {
        summary: value["summary"]
            .as_str()
            .unwrap_or("Design proposal")
            .into(),
        supported,
        operations: if supported { ops } else { vec![] },
        base,
        id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> NativeDocument {
        NativeDocument {
            id: uuid::Uuid::new_v4().to_string(),
            engine: "GIMP".into(),
            version: uuid::Uuid::new_v4().to_string(),
            name: "Layered".into(),
            file: "document.xcf".into(),
            preview: "data:image/png;base64,AA==".into(),
            width: 640,
            height: 400,
            layers: vec![Layer {
                id: "3".into(),
                name: "Painting".into(),
                kind: "paint".into(),
                visible: true,
                opacity: 100.,
                mode: "normal".into(),
                depth: 0,
                mask: false,
                locked: false,
            }],
            selected: Some("3".into()),
            selection: false,
            selection_preview: None,
            engine_version: "test".into(),
            presets: vec!["Basic".into()],
        }
    }
    #[test]
    fn rejected_commands_cannot_escape_engine_contract() {
        let mut doc = fixture();
        for op in [
            json!({"kind":"execute","code":"anything"}),
            json!({"kind":"opacity","layer":"missing","value":50}),
            json!({"kind":"opacity","layer":"3","value":101}),
            json!({"kind":"delete","layer":"3"}),
            json!({"kind":"crop","x":500,"y":0,"width":200,"height":10}),
        ] {
            assert!(validate_operations(&[op], &doc).is_err());
        }
        doc.layers[0].locked = true;
        assert!(validate_operations(&[json!({"kind":"invert","layer":"3"})], &doc).is_err());
    }
    #[test]
    fn degenerate_selection_does_not_turn_into_a_whole_canvas_fill() {
        let d = fixture();
        let p = json!({"x":0.5,"y":0.5,"pressure":1.0});
        assert!(validate_operations(&[json!({"kind":"select","points":[p,p,p,p]})], &d).is_err());
        assert!(validate_operations(&[json!({"kind":"select","points":[{"x":0.0,"y":0.0,"pressure":1.0},{"x":1.0,"y":0.0,"pressure":1.0},{"x":1.0,"y":1.0,"pressure":1.0}]})],&d).is_ok());
    }
    #[test]
    fn native_undo_restores_file_revision_and_rejects_stale_window() {
        let mut d = crate::document::Document::default();
        let mut p = d.project.clone();
        let first = fixture();
        p.native_documents.push(first.clone());
        d.commit(p.clone(), 0, "Open".into()).unwrap();
        p.native_documents[0].version = uuid::Uuid::new_v4().to_string();
        p.native_documents[0].file = "second.xcf".into();
        p.native_documents[0].layers[0].opacity = 50.;
        d.commit(p.clone(), 1, "Opacity".into()).unwrap();
        assert!(d.commit(p.clone(), 1, "Stale".into()).is_err());
        assert_eq!(d.undo().project.native_documents[0], first);
        assert_eq!(d.redo().project.native_documents[0], p.native_documents[0]);
    }
    #[test]
    fn project_move_preserves_native_files_without_cache_dependencies() {
        let folder =
            std::env::temp_dir().join(format!("workshop-portability-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(folder.join("before")).unwrap();
        let mut p = Project::default();
        let mut d = fixture();
        let native = folder.join("cached.xcf");
        fs::write(&native, b"native document fixture").unwrap();
        d.file = native.to_string_lossy().into();
        p.native_documents.push(d);
        let mut portable = portable_project(&p, &folder.join("before/project.workshop")).unwrap();
        assert!(Path::new(&portable.native_documents[0].file).is_relative());
        fs::rename(folder.join("before"), folder.join("after")).unwrap();
        fs::remove_file(native).unwrap();
        resolve_project(&mut portable, &folder.join("after/project.workshop")).unwrap();
        assert_eq!(
            fs::read(&portable.native_documents[0].file).unwrap(),
            b"native document fixture"
        );
        portable.native_documents[0].file = "../outside.xcf".into();
        assert!(resolve_project(&mut portable, &folder.join("after/project.workshop")).is_err());
        fs::remove_dir_all(folder).unwrap();
    }
}
