use chrono::Local;
use std::path::{Path, PathBuf};

pub fn generate_conflict_path(original_path: &Path) -> PathBuf {
    let now = Local::now().format("%Y-%m-%d %H-%M-%S");
    let stem = original_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Datei".to_string());

    let ext = original_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let new_name = format!("{} (Konflikt {}){}", stem, now, ext);
    if let Some(parent) = original_path.parent() {
        parent.join(new_name)
    } else {
        PathBuf::from(new_name)
    }
}
