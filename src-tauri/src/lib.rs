mod agent;
mod document;
mod photos;
mod recovery;
use base64::{engine::general_purpose::STANDARD, Engine};
use document::*;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Default, Serialize)]
pub struct RenderState {
    pub status: String,
    pub revision: u64,
    pub pending_revision: Option<u64>,
    pub image: Option<String>,
    pub error: Option<String>,
}
pub struct Studio {
    pub document: Mutex<Document>,
    pub render: Mutex<RenderState>,
    pub recovery: Mutex<Option<std::sync::mpsc::Sender<Snapshot>>>,
}
impl Default for Studio {
    fn default() -> Self {
        Self {
            document: Mutex::new(Document::default()),
            render: Mutex::new(RenderState {
                status: "idle".into(),
                ..Default::default()
            }),
            recovery: Mutex::new(None),
        }
    }
}
type Reply<T> = Result<T, String>;
fn publish(app: &tauri::AppHandle, s: &Snapshot) {
    let _ = app.emit("document-changed", s);
    if let Ok(tx) = app.state::<Studio>().recovery.lock() {
        if let Some(tx) = tx.as_ref() {
            let _ = tx.send(s.clone());
        }
    }
}
#[tauri::command]
fn new_project(app: tauri::AppHandle) -> Reply<Snapshot> {
    let state = app.state::<Studio>();
    let mut d = state.document.lock().map_err(|e| e.to_string())?;
    let revision = d.revision + 1;
    *d = Document::default();
    d.revision = revision;
    d.saved_revision = revision;
    d.project.name = "Untitled photo project".into();
    d.history = vec!["New photo project".into()];
    let s = d.snapshot();
    publish(&app, &s);
    Ok(s)
}
#[tauri::command]
fn get_document(state: State<Studio>) -> Reply<Snapshot> {
    Ok(state.document.lock().map_err(|e| e.to_string())?.snapshot())
}
#[tauri::command]
fn commit_project(
    app: tauri::AppHandle,
    state: State<Studio>,
    project: Project,
    base: u64,
    label: String,
) -> Reply<Snapshot> {
    let s = state
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .commit(project, base, label)?;
    publish(&app, &s);
    Ok(s)
}
#[tauri::command]
fn history_step(app: tauri::AppHandle, state: State<Studio>, redo: bool) -> Reply<Snapshot> {
    let mut d = state.document.lock().map_err(|e| e.to_string())?;
    let s = if redo { d.redo() } else { d.undo() };
    publish(&app, &s);
    Ok(s)
}
#[tauri::command]
async fn save_project(app: tauri::AppHandle, path: String) -> Reply<Snapshot> {
    let state = app.state::<Studio>();
    let s = state.document.lock().map_err(|e| e.to_string())?.snapshot();
    let bytes = serde_json::to_vec_pretty(&s.project).map_err(|e| e.to_string())?;
    if bytes.len() > 100_000_000 {
        return Err("The project exceeds the 100 MB file limit".into());
    }
    let dest = PathBuf::from(&path);
    let temp = dest.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temp, &dest).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })?;
    let mut d = state.document.lock().map_err(|e| e.to_string())?;
    d.saved_revision = s.revision;
    d.file = Some(path);
    let out = d.snapshot();
    publish(&app, &out);
    Ok(out)
}
#[tauri::command]
async fn open_project(app: tauri::AppHandle, path: String) -> Reply<Snapshot> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 100_000_000 {
        return Err("Project exceeds 100 MB".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let p: Project = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let s = app
        .state::<Studio>()
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .load(p, path)?;
    publish(&app, &s);
    Ok(s)
}
#[tauri::command]
async fn import_image(path: String) -> Reply<Asset> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("Choose a PNG, JPEG or WebP image".into()),
    };
    if fs::metadata(p).map_err(|e| e.to_string())?.len() > 20_000_000 {
        return Err("Choose an image smaller than 20 MB".into());
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let data_url: std::sync::Arc<str> =
        format!("data:{mime};base64,{}", STANDARD.encode(bytes)).into();
    let check = data_url.clone();
    tauri::async_runtime::spawn_blocking(move || photos::decode(&check))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Asset {
        id: uuid::Uuid::new_v4().to_string(),
        name: p.file_name().unwrap_or_default().to_string_lossy().into(),
        data_url,
    })
}
#[tauri::command]
fn detach_window(app: tauri::AppHandle, kind: String) -> Reply<()> {
    if !["wireframe", "render", "workflows", "library", "photos"].contains(&kind.as_str()) {
        return Err("Unknown workspace".into());
    }
    let label = format!("viewport-{kind}");
    if let Some(w) = app.get_webview_window(&label) {
        w.show().map_err(|e| e.to_string())?;
        return w.set_focus().map_err(|e| e.to_string());
    }
    let url = tauri::WebviewUrl::App(format!("index.html?view={kind}").into());
    tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("Reality Workshop — {kind}"))
        .inner_size(1080., 780.)
        .min_inner_size(720., 520.)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[derive(Serialize)]
struct Integration {
    name: String,
    available: bool,
    path: Option<String>,
    capability: String,
}
pub fn executable(name: &str) -> Option<PathBuf> {
    if name == "Codex" {
        if let Some(path) = std::env::var_os("REALITY_WORKSHOP_CODEX") {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
        // Prefer the desktop app's current protocol over an older standalone CLI.
        for path in [
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
        ] {
            if Path::new(path).is_file() {
                return Some(path.into());
            }
        }
    }
    let mac = match name {
        "Blender" => "/Applications/Blender.app/Contents/MacOS/Blender",
        "FreeCAD" => "/Applications/FreeCAD.app/Contents/MacOS/FreeCAD",
        "GIMP" => "/Applications/GIMP.app/Contents/MacOS/gimp",
        "Krita" => "/Applications/krita.app/Contents/MacOS/krita",
        "darktable" => "/Applications/darktable.app/Contents/MacOS/darktable",
        _ => "",
    };
    if Path::new(mac).is_file() {
        return Some(mac.into());
    }
    let bin = if name == "FreeCAD" {
        "FreeCAD".to_string()
    } else {
        name.to_lowercase()
    };
    let mut dirs: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    for d in dirs {
        for suffix in ["", ".exe"] {
            let p = d.join(format!("{bin}{suffix}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}
#[tauri::command]
fn integrations() -> Vec<Integration> {
    ["Blender", "FreeCAD", "GIMP", "Krita", "darktable", "Codex"]
        .into_iter()
        .map(|n| {
            let p = executable(n);
            Integration {
                name: n.into(),
                available: p.is_some(),
                path: p.map(|p| p.to_string_lossy().into()),
                capability: match n {
                    "Blender" => "Background rendering",
                    "Codex" => "Design proposals via App Server",
                    _ => "Adapter planned",
                }
                .into(),
            }
        })
        .collect()
}
#[tauri::command]
fn get_render(state: State<Studio>) -> Reply<RenderState> {
    Ok(state.render.lock().map_err(|e| e.to_string())?.clone())
}
#[tauri::command]
async fn start_render(app: tauri::AppHandle, revision: u64, gltf: String) -> Reply<RenderState> {
    let exe = executable("Blender")
        .ok_or("Blender was not found. Install Blender to enable final rendering.")?;
    if gltf.len() > 25_000_000 {
        return Err("Scene export is too large".into());
    }
    let _: serde_json::Value = serde_json::from_str(&gltf).map_err(|e| e.to_string())?;
    {
        let state = app.state::<Studio>();
        let d = state.document.lock().map_err(|e| e.to_string())?;
        if d.revision != revision {
            return Err("Scene changed before render started. Try again.".into());
        }
        let mut r = state.render.lock().map_err(|e| e.to_string())?;
        if r.status == "running" {
            return Err("A render is already running".into());
        }
        r.status = "running".into();
        r.error = None;
        r.pending_revision = Some(revision);
        let _ = app.emit("render-changed", r.clone());
    }
    let result = render_inner(&app, exe, revision, gltf).await;
    let state = app.state::<Studio>();
    let mut r = state.render.lock().map_err(|e| e.to_string())?;
    match result {
        Ok(image) => {
            *r = RenderState {
                status: "complete".into(),
                revision,
                pending_revision: None,
                image: Some(image),
                error: None,
            }
        }
        Err(e) => {
            r.status = "failed".into();
            r.pending_revision = None;
            r.error = Some(e)
        }
    }
    let out = r.clone();
    let _ = app.emit("render-changed", &out);
    Ok(out)
}
async fn render_inner(
    app: &tauri::AppHandle,
    exe: PathBuf,
    _revision: u64,
    gltf: String,
) -> Reply<String> {
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("renders")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    fs::write(folder.join("scene.gltf"), gltf).map_err(|e| e.to_string())?;
    fs::write(
        folder.join("render.py"),
        include_str!("../workers/render.py"),
    )
    .map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(240),
        tokio::process::Command::new(exe)
            .args(["--background", "--factory-startup", "--python"])
            .arg(folder.join("render.py"))
            .arg("--")
            .arg(&folder)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Render exceeded four minutes".to_string())?
    .map_err(|e| e.to_string())?;
    fs::write(
        folder.join("render.log"),
        [output.stdout.as_slice(), output.stderr.as_slice()].concat(),
    )
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Blender render failed. Log: {}",
            folder.join("render.log").display()
        ));
    }
    let bytes = fs::read(folder.join("render.png")).map_err(|e| format!("No render image: {e}"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}
pub fn run() {
    tauri::Builder::default()
        .manage(Studio::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            recovery::start(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_document,
            new_project,
            commit_project,
            history_step,
            save_project,
            open_project,
            import_image,
            detach_window,
            integrations,
            get_render,
            start_render,
            agent::agent_propose,
            agent::photo_propose,
            photos::photo_preview,
            photos::export_photos
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start Reality Workshop");
}
