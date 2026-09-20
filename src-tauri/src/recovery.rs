use crate::{
    document::{Document, Project, Snapshot},
    Studio,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::mpsc};
use tauri::{Emitter, Manager};

#[derive(Serialize, Deserialize)]
struct Recovery {
    project: Project,
    file: Option<String>,
    dirty: bool,
}
pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let folder = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = folder.join("recovery.workshop.json");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(r) = serde_json::from_slice::<Recovery>(&bytes) {
            let mut d = Document::default();
            if d.load(r.project, r.file.clone().unwrap_or_default())
                .is_ok()
            {
                d.file = r.file;
                d.saved_revision = if r.dirty { 0 } else { d.revision };
                d.history = vec![if r.dirty {
                    "Recovered unsaved project".into()
                } else {
                    "Restored last project".into()
                }];
                *app.state::<Studio>()
                    .document
                    .lock()
                    .map_err(|e| e.to_string())? = d;
            }
        }
    }
    let (tx, rx) = mpsc::channel::<Snapshot>();
    *app.state::<Studio>()
        .recovery
        .lock()
        .map_err(|e| e.to_string())? = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut written_revision = 0;
        while let Ok(mut s) = rx.recv() {
            std::thread::sleep(std::time::Duration::from_millis(200));
            while let Ok(newer) = rx.try_recv() {
                if newer.revision >= s.revision {
                    s = newer;
                }
            }
            if s.revision < written_revision {
                continue;
            }
            let result = write(&path, &s);
            if result.is_ok() {
                written_revision = s.revision;
            }
            let _ = app.emit(
                "recovery-status",
                serde_json::json!({"revision":s.revision,"ok":result.is_ok(),"error":result.err()}),
            );
        }
    });
    Ok(())
}
fn write(path: &PathBuf, s: &Snapshot) -> Result<(), String> {
    let bytes = serde_json::to_vec(&Recovery {
        project: s.project.clone(),
        file: s.file.clone(),
        dirty: s.revision != s.saved_revision,
    })
    .map_err(|e| e.to_string())?;
    let temp = path.with_extension("pending");
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_preserves_dirty_status_and_original_save_path() {
        let dir = std::env::temp_dir().join(format!("workshop-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("recovery.json");
        let mut d = Document::default();
        d.file = Some("original.workshop".into());
        let mut p = d.project.clone();
        p.name = "Recovered work".into();
        d.commit(p, 0, "Rename".into()).unwrap();
        write(&path, &d.snapshot()).unwrap();
        let r: Recovery = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(r.dirty);
        assert_eq!(r.file.as_deref(), Some("original.workshop"));
        assert_eq!(r.project.name, "Recovered work");
        d.saved_revision = d.revision;
        write(&path, &d.snapshot()).unwrap();
        let r: Recovery = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!r.dirty);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
