pub mod api;
pub mod conflict;
pub mod watcher;

use crate::config::SyncConfig;
use crate::state::{CloudFolderSummary, QuotaInfo, SharedState, SyncActivityItem, SyncProgress, SyncStatus};
use api::PureCloudApiClient;
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use walkdir::WalkDir;

pub struct SyncEngine {
    config: Arc<tokio::sync::RwLock<SyncConfig>>,
    state: SharedState,
    trigger_tx: mpsc::Sender<()>,
    stop_flag: Arc<AtomicBool>,
}

impl SyncEngine {
    pub fn new(config: SyncConfig, state: SharedState) -> (Self, mpsc::Receiver<()>) {
        let (trigger_tx, trigger_rx) = mpsc::channel(10);
        let stop_flag = Arc::new(AtomicBool::new(false));

        let engine = Self {
            config: Arc::new(tokio::sync::RwLock::new(config)),
            state,
            trigger_tx,
            stop_flag,
        };

        (engine, trigger_rx)
    }

    pub fn trigger_sync(&self) {
        let _ = self.trigger_tx.try_send(());
    }

    pub async fn update_config(&self, new_config: SyncConfig) {
        let mut cfg = self.config.write().await;
        *cfg = new_config;
        self.trigger_sync();
    }

    pub async fn run_loop(
        config_lock: Arc<tokio::sync::RwLock<SyncConfig>>,
        state: SharedState,
        mut trigger_rx: mpsc::Receiver<()>,
        stop_flag: Arc<AtomicBool>,
    ) {
        let mut ticker = interval(Duration::from_secs(30));

        // Start file watcher
        let (watch_tx, mut watch_rx) = mpsc::channel(50);
        let _watcher_handle = {
            let cfg = config_lock.read().await;
            if cfg.is_configured() {
                watcher::LocalFileWatcher::start(&cfg.local_path, watch_tx.clone()).ok()
            } else {
                None
            }
        };

        while !stop_flag.load(Ordering::Relaxed) {
            tokio::select! {
                _ = ticker.tick() => {
                    let cfg = config_lock.read().await.clone();
                    if cfg.is_configured() && !cfg.is_paused {
                        Self::execute_sync_cycle(&cfg, &state).await;
                    }
                }
                Some(_) = trigger_rx.recv() => {
                    let cfg = config_lock.read().await.clone();
                    if cfg.is_configured() && !cfg.is_paused {
                        Self::execute_sync_cycle(&cfg, &state).await;
                    }
                }
                Some(_changed_path) = watch_rx.recv() => {
                    // Short debounce before running sync
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    let cfg = config_lock.read().await.clone();
                    if cfg.is_configured() && !cfg.is_paused {
                        Self::execute_sync_cycle(&cfg, &state).await;
                    }
                }
            }
        }
    }

    async fn execute_sync_cycle(config: &SyncConfig, state: &SharedState) {
        {
            let mut s = state.lock().await;
            if s.status == SyncStatus::Syncing {
                return; // Already in progress
            }
            s.status = SyncStatus::Syncing;
        }

        let api_client = match PureCloudApiClient::new(
            &config.server_url,
            &config.username,
            &config.token_or_password,
        ) {
            Ok(c) => c,
            Err(e) => {
                let mut s = state.lock().await;
                s.status = SyncStatus::Error(e);
                return;
            }
        };

        // 1. Quota abfragen
        if let Ok((used, total)) = api_client.get_storage_quota().await {
            let mut s = state.lock().await;
            let percent = if total > 0 {
                ((used as f64 / total as f64) * 100.0).min(100.0) as u8
            } else {
                0
            };
            s.quota = Some(QuotaInfo {
                used_bytes: used,
                total_bytes: total,
                used_percent: percent,
            });
        }

        // 2. Cloud Manifest abrufen (Zwei-Wege-Synchronisation)
        let manifest = match api_client.get_sync_manifest().await {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Konnte Cloud-Manifest nicht abrufen: {}", e);
                api::SyncManifestData {
                    folders: Vec::new(),
                    files: Vec::new(),
                }
            }
        };

        // Cloud-Ordnerliste im State für die UI aktualisieren (inklusive aktuellem Sync-Modus)
        {
            let mut s = state.lock().await;
            s.cloud_folders = manifest
                .folders
                .iter()
                .map(|f| CloudFolderSummary {
                    id: f.id,
                    name: f.name.clone(),
                    path: f.path.clone(),
                    sync_mode: config.get_folder_mode(&f.path),
                })
                .collect();
        }

        let local_root = PathBuf::from(&config.local_path);
        if !local_root.exists() {
            let _ = tokio::fs::create_dir_all(&local_root).await;
        }

        // 3. DOWNLOAD-PHASE (Cloud -> Lokal)
        // 3a. Alle Cloud-Ordner lokal anlegen (sofern Modus Download erlaubt)
        for remote_folder in &manifest.folders {
            let mode = config.get_folder_mode(&remote_folder.path);
            if mode == "disabled" || mode == "upload_only" {
                continue; // Ordner nicht lokal anlegen
            }

            let target_dir = local_root.join(&remote_folder.path);
            if !target_dir.exists() {
                if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
                    log::warn!("Konnte lokalen Ordner nicht erstellen {}: {}", remote_folder.path, e);
                }
            }
        }

        // 3b. Cloud-Dateien herunterladen wenn Modus Download erlaubt
        let total_downloads = manifest.files.len();
        for (idx, remote_file) in manifest.files.iter().enumerate() {
            let mode = config.get_folder_mode(&remote_file.path);
            if mode == "disabled" || mode == "upload_only" {
                continue; // Datei überspringen
            }

            let target_file = local_root.join(&remote_file.path);
            let needs_download = if !target_file.exists() {
                true
            } else if let Ok(meta) = tokio::fs::metadata(&target_file).await {
                meta.len() != remote_file.size_bytes
            } else {
                false
            };

            if needs_download {
                {
                    let mut s = state.lock().await;
                    let percent = if total_downloads > 0 {
                        (((idx + 1) as f64 / total_downloads as f64) * 100.0) as u8
                    } else {
                        100
                    };
                    s.progress = Some(SyncProgress {
                        current_file: format!("Herunterladen: {}", remote_file.path),
                        bytes_done: idx as u64,
                        bytes_total: total_downloads as u64,
                        percent,
                    });
                }

                match api_client.download_file(&remote_file.path, &target_file).await {
                    Ok(bytes) => {
                        let mut s = state.lock().await;
                        s.activities.insert(
                            0,
                            SyncActivityItem {
                                id: format!("down_{}", Utc::now().timestamp_millis()),
                                path: remote_file.path.clone(),
                                action: "download".to_string(),
                                size_bytes: bytes,
                                timestamp: Utc::now(),
                                status: "success".to_string(),
                                message: None,
                            },
                        );
                        if s.activities.len() > 100 {
                            s.activities.truncate(100);
                        }
                    }
                    Err(e) => {
                        log::warn!("Download-Fehler bei {}: {}", remote_file.path, e);
                    }
                }
            }
        }

        // 4. UPLOAD-PHASE (Lokal -> Cloud)
        let mut local_items = Vec::new();
        for entry in WalkDir::new(&local_root).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path == local_root {
                continue;
            }
            let filename = path.file_name().unwrap_or_default().to_string_lossy();
            if filename.starts_with('.')
                || filename.ends_with(".tmp")
                || filename.ends_with(".part")
                || filename.contains('~')
            {
                continue;
            }

            if let Ok(rel) = path.strip_prefix(&local_root) {
                let rel_str = rel.to_string_lossy().to_string();
                local_items.push((path.to_path_buf(), rel_str, entry.file_type().is_dir()));
            }
        }

        let remote_folder_paths: HashSet<String> = manifest.folders.iter().map(|f| f.path.clone()).collect();
        let remote_file_map: HashMap<String, u64> = manifest.files.iter().map(|f| (f.path.clone(), f.size_bytes)).collect();

        let total_items = local_items.len();
        for (idx, (abs_path, rel_path, is_dir)) in local_items.into_iter().enumerate() {
            let mode = config.get_folder_mode(&rel_path);
            if mode == "disabled" || mode == "download_only" {
                continue; // Ordner/Datei vom Upload ausschließen
            }

            if is_dir {
                if !remote_folder_paths.contains(&rel_path) {
                    let _ = api_client.create_remote_folder(&rel_path).await;
                }
            } else {
                let local_size = match tokio::fs::metadata(&abs_path).await {
                    Ok(m) => m.len(),
                    Err(_) => 0,
                };

                let needs_upload = match remote_file_map.get(&rel_path) {
                    Some(&rem_size) => rem_size != local_size,
                    None => true,
                };

                if needs_upload {
                    {
                        let mut s = state.lock().await;
                        let percent = if total_items > 0 {
                            (((idx + 1) as f64 / total_items as f64) * 100.0) as u8
                        } else {
                            100
                        };
                        s.progress = Some(SyncProgress {
                            current_file: format!("Hochladen: {}", rel_path),
                            bytes_done: local_size,
                            bytes_total: local_size,
                            percent,
                        });
                    }

                    match api_client.upload_file(&abs_path, &rel_path).await {
                        Ok(bytes) => {
                            let mut s = state.lock().await;
                            s.activities.insert(
                                0,
                                SyncActivityItem {
                                    id: format!("up_{}", Utc::now().timestamp_millis()),
                                    path: rel_path,
                                    action: "upload".to_string(),
                                    size_bytes: bytes,
                                    timestamp: Utc::now(),
                                    status: "success".to_string(),
                                    message: None,
                                },
                            );
                            if s.activities.len() > 100 {
                                s.activities.truncate(100);
                            }
                        }
                        Err(e) => {
                            log::warn!("Upload-Fehler bei {}: {}", rel_path, e);
                        }
                    }
                }
            }
        }

        // Sync abgeschlossen
        {
            let mut s = state.lock().await;
            s.status = SyncStatus::Idle;
            s.progress = None;
            s.last_sync_time = Some(Utc::now());
        }
    }
}
