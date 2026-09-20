use crate::{
    document::{Asset, PhotoRegion},
    Studio,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Cursor,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ColorAdjustments {
    pub exposure: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub warmth: f64,
}
impl Default for ColorAdjustments {
    fn default() -> Self {
        Self {
            exposure: 0.,
            contrast: 0.,
            saturation: 0.,
            warmth: 0.,
        }
    }
}
impl ColorAdjustments {
    pub fn validate(&self) -> Result<(), String> {
        for (v, lo, hi) in [
            (self.exposure, -3., 3.),
            (self.contrast, -100., 100.),
            (self.saturation, -100., 100.),
            (self.warmth, -100., 100.),
        ] {
            if !v.is_finite() || v < lo || v > hi {
                return Err("Unsupported photo adjustment".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct PhotoEdit {
    pub color: ColorAdjustments,
    pub quarter_turns: u8,
    pub flip_x: bool,
    pub crop: Option<Crop>,
}
impl PhotoEdit {
    pub fn validate(&self) -> Result<(), String> {
        self.color.validate()?;
        if self.quarter_turns > 3 {
            return Err("Unsupported rotation".into());
        }
        if let Some(c) = &self.crop {
            if [c.x, c.y, c.width, c.height].iter().any(|v| !v.is_finite())
                || c.x < 0.
                || c.y < 0.
                || c.width < 0.01
                || c.height < 0.01
                || c.x + c.width > 1.000001
                || c.y + c.height > 1.000001
            {
                return Err("Crop must stay inside the photo".into());
            }
        }
        Ok(())
    }
}
#[derive(Serialize)]
pub struct Preview {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}
type PreviewCache = HashMap<String, (std::sync::Arc<str>, RgbaImage)>;
static CACHE: OnceLock<Mutex<PreviewCache>> = OnceLock::new();
static PROCESSING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub fn decode(data: &str) -> Result<DynamicImage, String> {
    let bytes = STANDARD
        .decode(data.split_once(',').ok_or("Invalid image data")?.1)
        .map_err(|e| e.to_string())?;
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > 40_000_000 {
        return Err("This version supports images up to 40 megapixels".into());
    }
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img)
}
fn source(asset: &Asset, preview: bool) -> Result<RgbaImage, String> {
    if !preview {
        return Ok(decode(&asset.data_url)?.into_rgba8());
    }
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((data, img)) = cache.lock().map_err(|e| e.to_string())?.get(&asset.id) {
        if **data == *asset.data_url {
            return Ok(img.clone());
        }
    }
    let img = decode(&asset.data_url)?.thumbnail(1400, 1400).into_rgba8();
    let mut lock = cache.lock().map_err(|e| e.to_string())?;
    if lock.len() >= 8 {
        lock.clear();
    }
    lock.insert(asset.id.clone(), (asset.data_url.clone(), img.clone()));
    Ok(img)
}
fn adjust(pixel: &mut image::Rgba<u8>, c: &ColorAdjustments) {
    if *c == ColorAdjustments::default() {
        return;
    }
    let exposure = 2f64.powf(c.exposure);
    let mut rgb = [0.; 3];
    for i in 0..3 {
        let v = pixel[i] as f64 / 255.;
        let linear = if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        };
        let v = linear * exposure;
        rgb[i] = if v <= 0.0031308 {
            v * 12.92
        } else {
            1.055 * v.powf(1. / 2.4) - 0.055
        };
    }
    rgb[0] += c.warmth * 0.001;
    rgb[2] -= c.warmth * 0.001;
    let gray = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    let contrast = 2f64.powf(c.contrast / 100.);
    for i in 0..3 {
        let v = gray + (rgb[i] - gray) * (1. + c.saturation / 100.);
        pixel[i] = (((v - 0.5) * contrast + 0.5).clamp(0., 1.) * 255.).round() as u8;
    }
}
pub fn process(
    mut img: RgbaImage,
    edit: &PhotoEdit,
    regions: &[PhotoRegion],
    composition: bool,
) -> RgbaImage {
    for p in img.pixels_mut() {
        adjust(p, &edit.color);
    }
    let (w, h) = img.dimensions();
    // Scanline polygon fill avoids testing every vertex for every pixel.
    for r in regions {
        if r.adjustments == ColorAdjustments::default() {
            continue;
        }
        for y in 0..h {
            let ny = (y as f64 + 0.5) / h as f64;
            let mut xs = Vec::new();
            for i in 0..r.points.len() {
                let a = &r.points[i];
                let b = &r.points[(i + 1) % r.points.len()];
                if (a.y > ny) != (b.y > ny) {
                    xs.push(a.x + (ny - a.y) * (b.x - a.x) / (b.y - a.y));
                }
            }
            xs.sort_by(|a, b| a.total_cmp(b));
            for pair in xs.as_chunks::<2>().0 {
                let start = (pair[0] * w as f64 - 0.5).ceil().max(0.) as u32;
                let end = (pair[1] * w as f64 - 0.5).ceil().max(0.) as u32;
                for x in start.min(w)..end.min(w) {
                    adjust(img.get_pixel_mut(x, y), &r.adjustments);
                }
            }
        }
    }
    if composition {
        if let Some(c) = &edit.crop {
            let x = (c.x * w as f64).floor() as u32;
            let y = (c.y * h as f64).floor() as u32;
            let cw = ((c.width * w as f64).round() as u32).max(1).min(w - x);
            let ch = ((c.height * h as f64).round() as u32).max(1).min(h - y);
            img = image::imageops::crop_imm(&img, x, y, cw, ch).to_image();
        }
        if edit.flip_x {
            image::imageops::flip_horizontal_in_place(&mut img);
        }
        img = match edit.quarter_turns {
            1 => image::imageops::rotate90(&img),
            2 => image::imageops::rotate180(&img),
            3 => image::imageops::rotate270(&img),
            _ => img,
        };
    }
    img
}
fn encode(img: RgbaImage, format: &str) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    let mut dynimg = DynamicImage::ImageRgba8(img);
    let fmt = if format == "jpeg" {
        // JPEG has no alpha: composite transparent pixels on white.
        let mut rgba = dynimg.into_rgba8();
        for p in rgba.pixels_mut() {
            let a = p[3] as f32 / 255.;
            for i in 0..3 {
                p[i] = (p[i] as f32 * a + 255. * (1. - a)).round() as u8;
            }
        }
        dynimg = DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).into_rgb8());
        ImageFormat::Jpeg
    } else {
        ImageFormat::Png
    };
    dynimg.write_to(&mut out, fmt).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
pub fn preview_for(
    asset: &Asset,
    edit: &PhotoEdit,
    regions: &[PhotoRegion],
    composition: bool,
) -> Result<Preview, String> {
    edit.validate()?;
    for r in regions {
        r.adjustments.validate()?;
    }
    let img = process(source(asset, true)?, edit, regions, composition);
    let (width, height) = img.dimensions();
    Ok(Preview {
        data_url: format!(
            "data:image/png;base64,{}",
            STANDARD.encode(encode(img, "png")?)
        ),
        width,
        height,
    })
}
#[tauri::command]
pub async fn photo_preview(
    app: tauri::AppHandle,
    asset_id: String,
    edit: PhotoEdit,
    regions: Vec<PhotoRegion>,
    composition: bool,
) -> Result<Preview, String> {
    let project = app
        .state::<Studio>()
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .project
        .clone();
    let asset = project
        .assets
        .iter()
        .find(|a| a.id == asset_id)
        .ok_or("Photo no longer exists")?
        .clone();
    let mut check = project;
    check.regions = regions.clone();
    check.validate()?;
    let _permit = PROCESSING.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || preview_for(&asset, &edit, &regions, composition))
        .await
        .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
pub struct ExportResult {
    pub directory: String,
    pub files: Vec<String>,
}
#[tauri::command]
pub async fn export_photos(
    app: tauri::AppHandle,
    asset_ids: Vec<String>,
    directory: String,
    format: String,
    revision: u64,
) -> Result<ExportResult, String> {
    if !["png", "jpeg"].contains(&format.as_str()) {
        return Err("Choose PNG or JPEG".into());
    }
    let s = app
        .state::<Studio>()
        .document
        .lock()
        .map_err(|e| e.to_string())?
        .snapshot();
    if revision != s.revision {
        return Err("The project changed. Review it before exporting.".into());
    }
    if asset_ids.is_empty()
        || asset_ids.len() > 100
        || asset_ids
            .iter()
            .any(|id| !s.project.assets.iter().any(|a| &a.id == id))
    {
        return Err("Choose existing photos to export".into());
    }
    let folder = PathBuf::from(directory).join(format!("Workshop-export-{}", uuid::Uuid::new_v4()));
    let directory = folder.to_string_lossy().into_owned();
    let _permit = PROCESSING.acquire().await.map_err(|e| e.to_string())?;
    let result=tauri::async_runtime::spawn_blocking(move||{
        std::fs::create_dir(&folder).map_err(|e|e.to_string())?;
        let mut files=vec![];
        for (index,id) in asset_ids.iter().enumerate(){
            let a=s.project.assets.iter().find(|a|&a.id==id).ok_or("Missing photo")?;
            let edit=s.project.photo_edits.get(id).cloned().unwrap_or_default();
            let regions:Vec<_>=s.project.regions.iter().filter(|r|&r.asset_id==id).cloned().collect();
            let img=process(source(a,false)?,&edit,&regions,true);
            let name=std::path::Path::new(&a.name).file_stem().unwrap_or_default().to_string_lossy().chars().map(|c|if c.is_alphanumeric()||c=='-'||c=='_' {c}else{'_'}).take(80).collect::<String>();
            let path=folder.join(format!("{:03}-{name}.{}",index+1,if format=="jpeg"{"jpg"}else{"png"}));
            let bytes=encode(img,&format)?;
            std::fs::write(&path,bytes).map_err(|e|e.to_string())?;
            files.push(path.to_string_lossy().into_owned());
            let _=app.emit("photo-export-progress",serde_json::json!({"completed":index+1,"total":asset_ids.len()}));
        }
        // Recipe manifest permits tracing an export to its editable settings.
        let manifest=serde_json::json!({"revision":revision,"photo_edits":s.project.photo_edits,"regions":s.project.regions,"files":files});
        std::fs::write(folder.join("recipe.json"),serde_json::to_vec_pretty(&manifest).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        Ok(ExportResult{directory,files})
    }).await.map_err(|e|e.to_string())?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> RgbaImage {
        RgbaImage::from_fn(8, 6, |x, y| {
            image::Rgba([
                (20 + x * 20) as u8,
                (30 + y * 25) as u8,
                80,
                if x == 0 { 0 } else { 255 },
            ])
        })
    }
    #[test]
    fn identity_is_pixel_exact() {
        let original = sample();
        assert_eq!(
            process(original.clone(), &PhotoEdit::default(), &[], true),
            original
        );
    }
    #[test]
    fn crop_rotation_and_alpha() {
        let mut e = PhotoEdit::default();
        e.crop = Some(Crop {
            x: 0.25,
            y: 0.,
            width: 0.5,
            height: 1.,
        });
        e.quarter_turns = 1;
        let img = process(sample(), &e, &[], true);
        assert_eq!(img.dimensions(), (6, 4));
        assert_eq!(*img.get_pixel(5, 0), *sample().get_pixel(2, 0));
        let png = encode(img.clone(), "png").unwrap();
        assert_eq!(image::load_from_memory(&png).unwrap().into_rgba8(), img);
    }
    #[test]
    fn masked_adjustment_preserves_outside_pixels() {
        let original = sample();
        let region = PhotoRegion {
            id: "r".into(),
            asset_id: "a".into(),
            instruction: "Brighten left".into(),
            points: vec![(0., 0.), (0.5, 0.), (0.5, 1.), (0., 1.)]
                .into_iter()
                .map(|(x, y)| crate::document::RegionPoint {
                    x,
                    y,
                    pressure: 0.5,
                })
                .collect(),
            adjustments: ColorAdjustments {
                exposure: 1.,
                ..Default::default()
            },
        };
        let img = process(original.clone(), &PhotoEdit::default(), &[region], true);
        assert!(img.get_pixel(2, 2)[0] > original.get_pixel(2, 2)[0]);
        assert_eq!(img.get_pixel(5, 2), original.get_pixel(5, 2));
        assert_eq!(img.get_pixel(0, 0)[3], 0);
    }
    #[test]
    fn jpeg_export_flattens_alpha_to_white() {
        let bytes = encode(
            RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 0])),
            "jpeg",
        )
        .unwrap();
        let img = image::load_from_memory(&bytes).unwrap().into_rgb8();
        assert!(img.get_pixel(0, 0)[0] > 250);
    }
    #[test]
    fn invalid_edits_rejected() {
        assert!(PhotoEdit {
            quarter_turns: 4,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(ColorAdjustments {
            exposure: f64::NAN,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn import_applies_camera_exif_orientation() {
        let jpeg = encode(sample(), "jpeg").unwrap();
        // Little-endian TIFF with orientation=6 (90 degrees clockwise).
        let exif: Vec<u8> = vec![
            69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6,
            0, 0, 0, 0, 0, 0, 0,
        ];
        let mut oriented = vec![255, 216, 255, 225];
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend(exif);
        oriented.extend_from_slice(&jpeg[2..]);
        let data = format!("data:image/jpeg;base64,{}", STANDARD.encode(oriented));
        assert_eq!(decode(&data).unwrap().into_rgba8().dimensions(), (6, 8));
    }
}
