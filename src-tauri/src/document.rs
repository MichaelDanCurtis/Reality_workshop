use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SceneSettings {
    pub pool_width: f64,
    pub pool_length: f64,
    pub coping: f64,
    pub water_color: String,
    pub sun_angle: f64,
}
impl Default for SceneSettings {
    fn default() -> Self {
        Self {
            pool_width: 6.0,
            pool_length: 9.0,
            coping: 0.45,
            water_color: "#42b9be".into(),
            sun_angle: 45.0,
        }
    }
}
impl SceneSettings {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, lo, hi) in [
            ("Pool width", self.pool_width, 2., 12.),
            ("Pool length", self.pool_length, 3., 16.),
            ("Coping", self.coping, 0.1, 1.5),
            ("Sun angle", self.sun_angle, 5., 175.),
        ] {
            if !value.is_finite() || value < lo || value > hi {
                return Err(format!("{name} must be between {lo} and {hi}"));
            }
        }
        if self.water_color.len() != 7
            || !self.water_color.starts_with('#')
            || !self.water_color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid water color".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub data_url: std::sync::Arc<str>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RegionPoint {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PhotoRegion {
    pub id: String,
    pub asset_id: String,
    pub instruction: String,
    pub points: Vec<RegionPoint>,
    #[serde(default)]
    pub adjustments: crate::photos::ColorAdjustments,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub schema: u32,
    pub name: String,
    pub scene: SceneSettings,
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub regions: Vec<PhotoRegion>,
    #[serde(default)]
    pub photo_edits: std::collections::HashMap<String, crate::photos::PhotoEdit>,
    #[serde(default)]
    pub native_documents: Vec<crate::engines::NativeDocument>,
    #[serde(default)]
    pub spatial_documents: Vec<crate::spatial::SpatialDocument>,
    #[serde(default)]
    pub developed_photos: Vec<crate::develop::DevelopedPhoto>,
    #[serde(default)]
    pub workflows: Vec<WorkflowRecipe>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WorkflowRecipe {
    pub id: String,
    pub name: String,
    pub source: String,
    pub selected: String,
    pub mode: String,
    pub instruction: String,
    pub script: String,
    pub positions: Vec<[f64; 2]>,
}
impl Default for Project {
    fn default() -> Self {
        Self {
            schema: 7,
            name: "Coastal house".into(),
            scene: SceneSettings::default(),
            assets: vec![],
            regions: vec![],
            photo_edits: Default::default(),
            native_documents: vec![],
            spatial_documents: vec![],
            developed_photos: vec![],
            workflows: vec![],
        }
    }
}
impl Project {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != 7 {
            return Err("Unsupported project version".into());
        }
        if self.name.trim().is_empty() || self.name.len() > 120 {
            return Err("Invalid project name".into());
        }
        if self.assets.len() > 100 {
            return Err("This build supports up to 100 reference images".into());
        }
        if self.assets.iter().map(|a| a.data_url.len()).sum::<usize>() > 90_000_000 {
            return Err("This project has reached the 90 MB reference limit. Use a separate project for more photos.".into());
        }
        let mut ids = std::collections::HashSet::new();
        for a in &self.assets {
            if a.id.is_empty() || !ids.insert(&a.id) {
                return Err("Photo identifiers must be unique".into());
            }
            if !(a.data_url.starts_with("data:image/png;base64,")
                || a.data_url.starts_with("data:image/jpeg;base64,")
                || a.data_url.starts_with("data:image/webp;base64,"))
            {
                return Err("Unsupported reference image".into());
            }
            if a.data_url.len() > 28_000_000 {
                return Err("Reference image exceeds 20 MB".into());
            }
        }
        if self.regions.len() > 500 {
            return Err("This build supports up to 500 photo regions".into());
        }
        let estimated_size = self
            .native_documents
            .iter()
            .map(|d| {
                d.preview.len()
                    + d.selection_preview.as_ref().map_or(0, |p| p.len())
                    + d.layers.len() * 1000
                    + d.presets.iter().map(String::len).sum::<usize>()
            })
            .sum::<usize>()
            + self
                .developed_photos
                .iter()
                .map(|p| p.preview.len() + p.original_preview.len())
                .sum::<usize>()
            + self
                .spatial_documents
                .iter()
                .flat_map(|d| &d.objects)
                .map(|o| (o.vertices.len() + o.triangles.len()) * 24)
                .sum::<usize>()
            + self.assets.iter().map(|a| a.data_url.len()).sum::<usize>()
            + self
                .regions
                .iter()
                .map(|r| r.points.len() * 200 + r.instruction.len() * 2)
                .sum::<usize>();
        if estimated_size > 95_000_000 {
            return Err(
                "The project is too large. Split the photos or regions into another project."
                    .into(),
            );
        }
        let mut region_ids = std::collections::HashSet::new();
        for region in &self.regions {
            region.adjustments.validate()?;
            if region.id.is_empty()
                || !region_ids.insert(&region.id)
                || !self.assets.iter().any(|a| a.id == region.asset_id)
                || region.instruction.trim().is_empty()
                || region.instruction.len() > 8000
                || !(3..=4096).contains(&region.points.len())
                || region.points.iter().any(|p| {
                    [p.x, p.y, p.pressure]
                        .iter()
                        .any(|n| !n.is_finite() || !(0.0..=1.0).contains(n))
                })
            {
                return Err("Invalid photo region: choose an existing image, draw a region, and add an instruction".into());
            }
        }
        for (id, edit) in &self.photo_edits {
            if !self.assets.iter().any(|a| &a.id == id) {
                return Err("An edit references a missing photo".into());
            }
            edit.validate()?;
        }
        crate::engines::validate_documents(&self.native_documents)?;
        crate::spatial::validate(&self.spatial_documents)?;
        crate::develop::validate(&self.developed_photos)?;
        if self.workflows.len() > 32
            || self.workflows.iter().any(|w| {
                uuid::Uuid::parse_str(&w.id).is_err()
                    || w.name.is_empty()
                    || w.name.len() > 120
                    || w.source.len() > 200
                    || w.selected.len() > 200
                    || !matches!(w.mode.as_str(), "ai" | "script")
                    || w.instruction.len() > 8000
                    || w.script.len() > 64000
                    || w.positions.len() != 3
                    || w.positions
                        .iter()
                        .flatten()
                        .any(|v| !v.is_finite() || !(0.0..=1500.0).contains(v))
            })
        {
            return Err("Invalid saved workflow".into());
        }
        self.scene.validate()
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub project: Project,
    pub revision: u64,
    pub saved_revision: u64,
    pub can_undo: bool,
    pub can_redo: bool,
    pub history: Vec<String>,
    pub file: Option<String>,
}
pub struct Document {
    pub project: Project,
    pub revision: u64,
    pub saved_revision: u64,
    undo: Vec<(Project, String)>,
    redo: Vec<(Project, String)>,
    pub history: Vec<String>,
    pub file: Option<String>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            project: Project::default(),
            revision: 0,
            saved_revision: 0,
            undo: vec![],
            redo: vec![],
            history: vec!["Starter scene".into()],
            file: None,
        }
    }
}
impl Document {
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            project: self.project.clone(),
            revision: self.revision,
            saved_revision: self.saved_revision,
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            history: self.history.clone(),
            file: self.file.clone(),
        }
    }
    pub fn commit(
        &mut self,
        project: Project,
        base: u64,
        label: String,
    ) -> Result<Snapshot, String> {
        if base != self.revision {
            return Err(
                "The project changed in another window. Review the latest state and try again."
                    .into(),
            );
        }
        project.validate()?;
        if project == self.project {
            return Ok(self.snapshot());
        }
        self.undo.push((self.project.clone(), label.clone()));
        if self.undo.len() > 100 {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.project = project;
        self.revision += 1;
        self.history.push(label);
        if self.history.len() > 30 {
            self.history.remove(0);
        }
        Ok(self.snapshot())
    }
    pub fn undo(&mut self) -> Snapshot {
        if let Some((p, l)) = self.undo.pop() {
            self.redo.push((self.project.clone(), l.clone()));
            self.project = p;
            self.revision += 1;
            self.history.push(format!("Undo · {l}"));
        }
        self.snapshot()
    }
    pub fn redo(&mut self) -> Snapshot {
        if let Some((p, l)) = self.redo.pop() {
            self.undo.push((self.project.clone(), l.clone()));
            self.project = p;
            self.revision += 1;
            self.history.push(format!("Redo · {l}"));
        }
        self.snapshot()
    }
    pub fn load(&mut self, mut p: Project, path: String) -> Result<Snapshot, String> {
        if (1..=6).contains(&p.schema) {
            p.schema = 7;
        }
        p.validate()?;
        self.project = p;
        self.revision += 1;
        self.saved_revision = self.revision;
        self.file = Some(path);
        self.undo.clear();
        self.redo.clear();
        self.history = vec!["Opened project".into()];
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_window_cannot_overwrite_another_edit() {
        let mut d = Document::default();
        let mut p = d.project.clone();
        p.scene.pool_width = 7.;
        d.commit(p.clone(), 0, "Width".into()).unwrap();
        p.scene.pool_length = 12.;
        assert!(d.commit(p, 0, "Stale".into()).is_err());
        assert_eq!(d.project.scene.pool_length, 9.);
    }
    #[test]
    fn undo_redo_and_branch_preserve_monotonic_revision() {
        let mut d = Document::default();
        let original = d.project.clone();
        let mut p = original.clone();
        p.scene.coping = 0.8;
        d.commit(p.clone(), 0, "Coping".into()).unwrap();
        assert_eq!(d.undo().project, original);
        assert_eq!(d.redo().project, p);
        assert_eq!(d.revision, 3);
        d.undo();
        d.commit(p, 4, "Branch".into()).unwrap();
        assert!(!d.snapshot().can_redo);
    }
    #[test]
    fn invalid_ai_proposal_does_not_change_document() {
        let mut d = Document::default();
        let mut p = d.project.clone();
        p.scene.pool_width = f64::NAN;
        assert!(d.commit(p, 0, "AI".into()).is_err());
        assert_eq!(d.revision, 0);
    }
    #[test]
    fn source_round_trip_and_unknown_version() {
        let p = Project::default();
        let bytes = serde_json::to_vec(&p).unwrap();
        let decoded: Project = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded, p);
        let mut bad = p;
        bad.schema = 99;
        assert!(bad.validate().is_err());
    }
    #[test]
    fn old_project_upgrades_without_changing_scene() {
        let mut original = Project::default();
        original.schema = 1;
        let mut json = serde_json::to_value(&original).unwrap();
        json.as_object_mut().unwrap().remove("regions");
        let old: Project = serde_json::from_value(json).unwrap();
        let mut d = Document::default();
        d.load(old, "old.workshop".into()).unwrap();
        assert_eq!(d.project.schema, 7);
        assert_eq!(d.project.scene, original.scene);
        assert!(d.project.regions.is_empty());
    }
    #[test]
    fn region_persists_and_undo_restores_original_image() {
        let mut d = Document::default();
        d.project.assets.push(Asset {
            id: "photo".into(),
            name: "test.png".into(),
            data_url: "data:image/png;base64,AA==".into(),
        });
        let original = d.project.clone();
        let mut changed = original.clone();
        changed.regions.push(PhotoRegion {
            id: "region".into(),
            asset_id: "photo".into(),
            instruction: "Pool here".into(),
            adjustments: Default::default(),
            points: vec![
                RegionPoint {
                    x: 0.1,
                    y: 0.1,
                    pressure: 0.5,
                },
                RegionPoint {
                    x: 0.8,
                    y: 0.1,
                    pressure: 0.8,
                },
                RegionPoint {
                    x: 0.5,
                    y: 0.8,
                    pressure: 1.0,
                },
            ],
        });
        d.commit(changed.clone(), 0, "Region".into()).unwrap();
        let reopened: Project =
            serde_json::from_slice(&serde_json::to_vec(&d.project).unwrap()).unwrap();
        assert_eq!(reopened, changed);
        assert_eq!(d.undo().project, original);
        assert_eq!(d.redo().project, changed);
        changed.regions[0].points[0].x = 1.1;
        assert!(changed.validate().is_err());
        changed.regions[0].points[0].x = 0.1;
        changed.regions[0].asset_id = "missing".into();
        assert!(changed.validate().is_err());
    }
}
