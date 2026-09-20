use crate::{
    document::{Project, Snapshot},
    publish, Reply, Studio,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub exposure: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub black: f64,
}
impl Settings {
    fn validate(&self) -> Reply<()> {
        for (v, lo, hi) in [
            (self.exposure, -5., 5.),
            (self.contrast, -1., 1.),
            (self.saturation, -1., 1.),
            (self.black, -0.1, 0.1),
        ] {
            if !v.is_finite() || v < lo || v > hi {
                return Err("Choose valid development settings".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DevelopedPhoto {
    pub id: String,
    pub version: String,
    pub name: String,
    pub source: String,
    pub sidecar: String,
    pub settings: Settings,
    pub preview: Arc<str>,
    pub original_preview: Arc<str>,
    pub rating: u8,
    pub tags: Vec<String>,
}
#[derive(Default)]
pub struct DevelopRuntime {
    gate: tokio::sync::Mutex<()>,
    previews: std::sync::Mutex<std::collections::HashMap<String, (u64, Vec<DevelopedPhoto>)>>,
}
pub fn validate(photos: &[DevelopedPhoto]) -> Reply<()> {
    if photos.len() > 100 {
        return Err("Use up to 100 developed photos per project".into());
    }
    let mut ids = std::collections::HashSet::new();
    for p in photos {
        p.settings.validate()?;
        if uuid::Uuid::parse_str(&p.id).is_err()
            || uuid::Uuid::parse_str(&p.version).is_err()
            || !ids.insert(&p.id)
            || p.name.len() > 200
            || p.rating > 5
            || p.tags.len() > 20
            || p.tags.iter().any(|t| t.len() > 80)
            || p.preview.len() > 8_000_000
            || p.original_preview.len() > 8_000_000
            || !p.preview.starts_with("data:image/png;base64,")
            || !p.original_preview.starts_with("data:image/png;base64,")
        {
            return Err("Invalid developed photograph".into());
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
    if !matches!(
        ext.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "tif"
            | "tiff"
            | "webp"
            | "dng"
            | "cr2"
            | "cr3"
            | "nef"
            | "nrw"
            | "arw"
            | "raf"
            | "rw2"
            | "orf"
            | "pef"
            | "srw"
            | "raw"
    ) || fs::metadata(path).map_err(|e| e.to_string())?.len() > 512_000_000
    {
        return Err("Choose a supported photograph or RAW file under 512 MB".into());
    }
    Ok(())
}
pub fn cli(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("REALITY_WORKSHOP_DARKTABLE_CLI") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let private = app
        .path()
        .app_data_dir()
        .ok()?
        .join("engines/darktable/bin/darktable-cli");
    if private.is_file() {
        return Some(private);
    }
    for p in [
        "/Applications/darktable.app/Contents/MacOS/darktable-cli",
        "/Applications/darktable.app/Contents/Resources/bin/darktable-cli",
        r"C:\Program Files\darktable\bin\darktable-cli.exe",
    ] {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for name in ["darktable-cli", "darktable-cli.exe"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}
/// Native basicadj v2 parameters, defined by darktable's versioned XMP format.
/// The engine handles module ordering, camera defaults, color transforms and export.
fn sidecar(settings: &Settings) -> String {
    let mut bytes = vec![];
    for v in [settings.black, settings.exposure, 0., 0., settings.contrast] {
        bytes.extend_from_slice(&(v as f32).to_le_bytes());
    }
    bytes.extend_from_slice(&1_i32.to_le_bytes()); // DT_RGB_NORM_LUMINANCE
    for v in [18.42, 0., settings.saturation, 0., 0.] {
        bytes.extend_from_slice(&(v as f32).to_le_bytes());
    }
    let params: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/" darktable:xmp_version="4" darktable:auto_presets_applied="0" darktable:history_end="1" darktable:iop_order_version="2"><darktable:history><rdf:Seq><rdf:li darktable:num="0" darktable:operation="basicadj" darktable:enabled="1" darktable:modversion="2" darktable:params="{params}" darktable:multi_name="Workshop" darktable:multi_priority="0" darktable:blendop_version="13"/></rdf:Seq></darktable:history></rdf:Description></rdf:RDF></x:xmpmeta>"#
    )
}
fn snapshot(app: &tauri::AppHandle, base: u64) -> Reply<Snapshot> {
    let s = app
        .state::<Studio>()
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .snapshot();
    if s.revision != base {
        return Err("The project changed. Review its latest state.".into());
    }
    Ok(s)
}
fn commit(app: &tauri::AppHandle, s: Snapshot, p: Project, label: &str) -> Reply<Snapshot> {
    let out = app
        .state::<Studio>()
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .commit(p, s.revision, label.into())?;
    publish(app, &out);
    Ok(out)
}
async fn render(
    app: &tauri::AppHandle,
    source: &Path,
    xmp: &Path,
    output: &Path,
    preview: bool,
) -> Reply<()> {
    let runtime = app.state::<DevelopRuntime>();
    let _guard = runtime.gate.lock().await;
    let exe =
        cli(app).ok_or("Install darktable with its command-line engine to develop photographs")?;
    let folder = output.parent().ok_or("Choose an output folder")?;
    let config = folder.join("darktable-config");
    let cache = folder.join("darktable-cache");
    fs::create_dir_all(&config).map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let log = fs::File::create(folder.join("darktable.log")).map_err(|e| e.to_string())?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg(source)
        .arg(xmp)
        .arg(output)
        .args(["--apply-custom-presets", "false"]);
    if preview {
        cmd.args(["--width", "1024", "--height", "1024"]);
    }
    let child = cmd
        .args(["--core", "--configdir"])
        .arg(config)
        .arg("--cachedir")
        .arg(cache)
        .args([
            "--conf",
            "write_sidecar_files=never",
            "--conf",
            "plugins/imageio/format/png/bpp=8",
        ])
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output())
        .await
        .map_err(|_| "Darktable timed out. The source and last revision are safe.")?
        .map_err(|e| e.to_string())?;
    if !result.status.success() || !output.is_file() {
        return Err(format!(
            "Darktable could not develop this image. See {}",
            folder.join("darktable.log").display()
        ));
    }
    Ok(())
}
async fn process(
    app: &tauri::AppHandle,
    photo: &DevelopedPhoto,
    settings: Settings,
) -> Reply<DevelopedPhoto> {
    settings.validate()?;
    source(Path::new(&photo.source))?;
    let version = uuid::Uuid::new_v4().to_string();
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("developed-photos")
        .join(&version);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let xmp = folder.join("recipe.xmp");
    fs::write(&xmp, sidecar(&settings)).map_err(|e| e.to_string())?;
    let preview = folder.join("preview.png");
    render(app, Path::new(&photo.source), &xmp, &preview, true).await?;
    let mut out = photo.clone();
    out.version = version;
    out.sidecar = xmp.to_string_lossy().into();
    out.settings = settings;
    out.preview = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(fs::read(preview).map_err(|e| e.to_string())?)
    )
    .into();
    if out.original_preview.is_empty() {
        out.original_preview = out.preview.clone();
    }
    validate(std::slice::from_ref(&out))?;
    Ok(out)
}
#[tauri::command]
pub async fn develop_import(
    app: tauri::AppHandle,
    paths: Vec<String>,
    asset_ids: Vec<String>,
    base: u64,
) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    if paths.len() + asset_ids.len() == 0
        || paths.len() + asset_ids.len() + s.project.developed_photos.len() > 100
    {
        return Err("Choose photographs within the 100-photo project limit".into());
    }
    let mut p = s.project.clone();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("photo-originals");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut inputs: Vec<(String, String)> = paths
        .iter()
        .map(|path| {
            (
                path.clone(),
                Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
            )
        })
        .collect();
    for id in asset_ids {
        let a = s
            .project
            .assets
            .iter()
            .find(|a| a.id == id)
            .ok_or("Choose an existing reference")?;
        let (prefix, body) = a
            .data_url
            .split_once(',')
            .ok_or("Invalid reference photograph")?;
        let ext = if prefix.contains("jpeg") {
            "jpg"
        } else if prefix.contains("webp") {
            "webp"
        } else {
            "png"
        };
        let file = root.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
        fs::write(&file, STANDARD.decode(body).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        inputs.push((file.to_string_lossy().into(), a.name.clone()));
    }
    for (path, name) in inputs {
        let input = Path::new(&path);
        source(input)?;
        let id = uuid::Uuid::new_v4().to_string();
        let dest = root.join(format!(
            "{}.{}",
            id,
            input.extension().unwrap_or_default().to_string_lossy()
        ));
        fs::copy(input, &dest).map_err(|e| e.to_string())?;
        let photo = DevelopedPhoto {
            id: id.clone(),
            version: id,
            name,
            source: dest.to_string_lossy().into(),
            sidecar: String::new(),
            settings: Settings::default(),
            preview: "".into(),
            original_preview: "".into(),
            rating: 0,
            tags: vec![],
        };
        p.developed_photos
            .push(process(&app, &photo, Settings::default()).await?);
    }
    commit(&app, s, p, "Import photographs into darktable")
}
#[tauri::command]
pub async fn develop_edit(
    app: tauri::AppHandle,
    ids: Vec<String>,
    settings: Settings,
    base: u64,
    preview: bool,
) -> Reply<Vec<DevelopedPhoto>> {
    let s = snapshot(&app, base)?;
    settings.validate()?;
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    if ids.is_empty() || ids.len() > 100 || unique.len() != ids.len() {
        return Err("Choose distinct photographs".into());
    }
    let mut p = s.project.clone();
    let mut output = vec![];
    for id in ids {
        let photo = p
            .developed_photos
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("Choose an existing photograph")?;
        *photo = process(&app, photo, settings.clone()).await?;
        output.push(photo.clone());
    }
    if !preview {
        commit(&app, s, p, "Develop photographs")?;
    } else {
        let runtime = app.state::<DevelopRuntime>();
        let mut previews = runtime.previews.lock().map_err(|e| e.to_string())?;
        if previews.len() >= 16 {
            previews.clear();
        }
        previews.insert(output[0].version.clone(), (base, output.clone()));
    }
    Ok(output)
}

#[tauri::command]
pub fn develop_apply_preview(app: tauri::AppHandle, version: String, base: u64) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    let runtime = app.state::<DevelopRuntime>();
    let (captured, photos) = runtime
        .previews
        .lock()
        .map_err(|e| e.to_string())?
        .get(&version)
        .cloned()
        .ok_or("This preview expired. Prepare a fresh preview.")?;
    if captured != base {
        return Err("This preview belongs to a different project revision.".into());
    }
    let mut p = s.project.clone();
    for photo in photos {
        let dest = p
            .developed_photos
            .iter_mut()
            .find(|p| p.id == photo.id)
            .ok_or("The previewed photograph is no longer in the project")?;
        *dest = photo;
    }
    let result = commit(&app, s, p, "Apply reviewed photo adjustments")?;
    runtime
        .previews
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&version);
    Ok(result)
}
#[tauri::command]
pub async fn develop_export(
    app: tauri::AppHandle,
    ids: Vec<String>,
    folder: String,
    base: u64,
) -> Reply<String> {
    let s = snapshot(&app, base)?;
    if ids.is_empty() || ids.len() > 100 {
        return Err("Choose photographs to export".into());
    }
    let root = PathBuf::from(folder);
    if !root.is_absolute() || !root.is_dir() {
        return Err("Choose an export folder".into());
    }
    let out = root.join(format!("Workshop-photos-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&out).map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        let photo = s
            .project
            .developed_photos
            .iter()
            .find(|p| &p.id == id)
            .ok_or("Choose an existing photograph")?;
        render(
            &app,
            Path::new(&photo.source),
            Path::new(&photo.sidecar),
            &out.join(format!("{:03}-{}.png", i + 1, photo.id)),
            false,
        )
        .await?;
        fs::copy(
            &photo.sidecar,
            out.join(format!("{:03}-{}.xmp", i + 1, photo.id)),
        )
        .map_err(|e| e.to_string())?;
    }
    fs::write(out.join("catalog.json"),serde_json::to_vec_pretty(&s.project.developed_photos.iter().filter(|p|ids.contains(&p.id)).map(|p|json!({"id":p.id,"name":p.name,"rating":p.rating,"tags":p.tags,"settings":p.settings})).collect::<Vec<_>>()).unwrap()).map_err(|e|e.to_string())?;
    Ok(out.to_string_lossy().into())
}
#[tauri::command]
pub async fn develop_propose(
    app: tauri::AppHandle,
    id: String,
    base: u64,
    prompt: String,
) -> Reply<Value> {
    if prompt.trim().is_empty() || prompt.len() > 8000 {
        return Err("Describe a photo adjustment".into());
    }
    let s = snapshot(&app, base)?;
    let photo = s
        .project
        .developed_photos
        .iter()
        .find(|p| p.id == id)
        .ok_or("Choose a photograph")?;
    let schema = json!({"type":"object","additionalProperties":false,"required":["summary","supported","settings"],"properties":{"summary":{"type":"string"},"supported":{"type":"boolean"},"settings":{"type":"object","additionalProperties":false,"required":["exposure","contrast","saturation","black"],"properties":{"exposure":{"type":"number"},"contrast":{"type":"number"},"saturation":{"type":"number"},"black":{"type":"number"}}}}});
    let v=crate::agent::run_codex(&app,"You are the photo design partner using darktable's native basic adjustment module. Propose exposure [-5,5] stops, contrast [-1,1], saturation [-1,1], and black [-0.1,0.1]. All neutral values are zero. Preserve unrequested settings; use absolute values. Never invent image generation or object removal. If unsupported, return supported:false and unchanged settings with an explanation. No tools, code, or file edits. User reviews and applies the native preview.",schema,vec![json!({"type":"text","text":format!("Settings: {}. Request: {}",serde_json::to_string(&photo.settings).unwrap(),prompt)}),json!({"type":"image","url":photo.preview})]).await?;
    let settings: Settings =
        serde_json::from_value(v["settings"].clone()).map_err(|e| e.to_string())?;
    settings.validate()?;
    Ok(json!({"summary":v["summary"],"supported":v["supported"],"settings":settings,"base":base}))
}
pub fn portable(project: &mut Project, path: &Path) -> Reply<()> {
    let folder = path.with_extension("workshop-assets");
    for p in &mut project.developed_photos {
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        for original in [&mut p.source, &mut p.sidecar] {
            let source = Path::new(&*original);
            let ext = source.extension().ok_or("Invalid photograph path")?;
            let filename = if source.extension().is_some_and(|e| e == "xmp") {
                format!("{}.xmp", p.version)
            } else {
                format!("{}.{}", p.id, ext.to_string_lossy())
            };
            let target = folder.join(&filename);
            if source != target && !target.exists() {
                fs::copy(source, &target).map_err(|e| e.to_string())?;
            }
            *original = format!(
                "{}/{}",
                folder.file_name().unwrap().to_string_lossy(),
                filename
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn develop_to_edit(app: tauri::AppHandle, id: String, base: u64) -> Reply<Snapshot> {
    let s = snapshot(&app, base)?;
    let p = s
        .project
        .developed_photos
        .iter()
        .find(|p| p.id == id)
        .ok_or("Choose a photograph")?;
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("photo-handoffs")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let name: String = Path::new(&p.name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .take(100)
        .collect();
    let image = folder.join(format!(
        "{}.png",
        if name.is_empty() {
            "Developed photo"
        } else {
            &name
        }
    ));
    render(
        &app,
        Path::new(&p.source),
        Path::new(&p.sidecar),
        &image,
        false,
    )
    .await?;
    crate::engines::engine_open(
        app,
        "GIMP".into(),
        Some(image.to_string_lossy().into()),
        None,
        1,
        1,
        base,
    )
    .await
}
pub fn resolve(project: &mut Project, path: &Path) -> Reply<()> {
    for p in &mut project.developed_photos {
        for text in [&mut p.source, &mut p.sidecar] {
            let file = PathBuf::from(&*text);
            if file
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("Invalid photo path".into());
            }
            let file = if file.is_relative() {
                path.parent().unwrap_or(Path::new(".")).join(file)
            } else {
                file
            };
            if !file.is_file() {
                return Err("A photograph or sidecar is missing from this project".into());
            }
            *text = file.to_string_lossy().into();
        }
        source(Path::new(&p.source))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> DevelopedPhoto {
        DevelopedPhoto {
            id: uuid::Uuid::new_v4().to_string(),
            version: uuid::Uuid::new_v4().to_string(),
            name: "Photo.dng".into(),
            source: "source.dng".into(),
            sidecar: "recipe.xmp".into(),
            settings: Settings::default(),
            preview: "data:image/png;base64,AA==".into(),
            original_preview: "data:image/png;base64,AA==".into(),
            rating: 5,
            tags: vec!["Architecture".into()],
        }
    }
    #[test]
    fn development_does_not_replace_originals_or_catalog_metadata() {
        let mut d = crate::document::Document::default();
        let mut p = d.project.clone();
        for _ in 0..40 {
            p.developed_photos.push(fixture());
        }
        d.commit(p.clone(), 0, "Import".into()).unwrap();
        let before = p.clone();
        for photo in &mut p.developed_photos {
            photo.settings.exposure = 1.;
            photo.version = uuid::Uuid::new_v4().to_string();
            photo.sidecar = "new-recipe.xmp".into();
        }
        d.commit(p, 1, "Batch recipe".into()).unwrap();
        for (a, b) in before
            .developed_photos
            .iter()
            .zip(&d.project.developed_photos)
        {
            assert_eq!(a.source, b.source);
            assert_eq!(a.original_preview, b.original_preview);
            assert_eq!(a.rating, b.rating);
            assert_eq!(a.tags, b.tags);
        }
        assert_eq!(d.undo().project, before);
        assert_eq!(d.redo().project.developed_photos[39].settings.exposure, 1.);
    }
    #[test]
    fn originals_and_native_recipes_survive_moving_the_project() {
        let root = std::env::temp_dir().join(format!("develop-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("old")).unwrap();
        let mut p = Project::default();
        let mut photo = fixture();
        let raw = root.join("raw.dng");
        let xmp = root.join("recipe.xmp");
        fs::write(&raw, b"unchanged original").unwrap();
        fs::write(&xmp, sidecar(&Settings::default())).unwrap();
        photo.source = raw.to_string_lossy().into();
        photo.sidecar = xmp.to_string_lossy().into();
        p.developed_photos.push(photo);
        portable(&mut p, &root.join("old/project.workshop")).unwrap();
        fs::rename(root.join("old"), root.join("new")).unwrap();
        fs::remove_file(raw).unwrap();
        fs::remove_file(xmp).unwrap();
        resolve(&mut p, &root.join("new/project.workshop")).unwrap();
        assert_eq!(
            fs::read(&p.developed_photos[0].source).unwrap(),
            b"unchanged original"
        );
        let first = p.developed_photos[0].source.clone();
        portable(&mut p, &root.join("new/project.workshop")).unwrap();
        resolve(&mut p, &root.join("new/project.workshop")).unwrap();
        assert_eq!(p.developed_photos[0].source, first);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_native_recipes_and_duplicate_photos_are_rejected() {
        assert!(Settings {
            exposure: f64::NAN,
            ..Settings::default()
        }
        .validate()
        .is_err());
        assert!(Settings {
            black: 1.,
            ..Settings::default()
        }
        .validate()
        .is_err());
        let p = fixture();
        assert!(validate(&[p.clone(), p]).is_err());
    }
}
