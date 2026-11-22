use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub server_url: String,
    pub username: String,
    pub token_or_password: String,
    pub local_path: String,
    pub sync_interval_secs: u64,
    pub is_paused: bool,
    pub auto_start: bool,
    pub theme: String,
}

impl Default for SyncConfig {
    fn default() -> Self {
        let default_sync_dir = directories::UserDirs::new()
            .map(|u| u.home_dir().join("PureCloud").to_string_lossy().to_string())
            .unwrap_or_else(|| "./PureCloud".to_string());

        Self {
            server_url: String::new(),
            username: String::new(),
            token_or_password: String::new(),
            local_path: default_sync_dir,
            sync_interval_secs: 30,
            is_paused: false,
            auto_start: false,
            theme: "dark".to_string(),
        }
    }
}

impl SyncConfig {
    pub fn config_path() -> PathBuf {
        if let Some(proj_dirs) = ProjectDirs::from("cloud", "PureCloud", "PureCloudSync") {
            let config_dir = proj_dirs.config_dir();
            let _ = fs::create_dir_all(config_dir);
            config_dir.join("config.json")
        } else {
            PathBuf::from("purecloud_config.json")
        }
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(cfg) = serde_json::from_str::<SyncConfig>(&content) {
                    return cfg;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Fehler beim Serialisieren der Konfiguration: {}", e))?;
        fs::write(&path, json)
            .map_err(|e| format!("Fehler beim Schreiben von {}: {}", path.display(), e))?;
        Ok(())
    }

    pub fn is_configured(&self) -> bool {
        !self.server_url.trim().is_empty()
            && !self.username.trim().is_empty()
            && !self.token_or_password.trim().is_empty()
            && !self.local_path.trim().is_empty()
    }
}
