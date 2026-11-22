pub mod config;
pub mod state;
pub mod sync;

use config::SyncConfig;
use state::{ClientStatusPayload, InnerState, SharedState, SyncStatus};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use sync::api::PureCloudApiClient;
use sync::SyncEngine;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

// Global App State wrapper for Tauri
pub struct AppContext {
    pub config: Arc<tokio::sync::RwLock<SyncConfig>>,
    pub state: SharedState,
    pub trigger_tx: tokio::sync::mpsc::Sender<()>,
}

#[tauri::command]
async fn get_status(app_ctx: State<'_, AppContext>) -> Result<ClientStatusPayload, String> {
    let cfg = app_ctx.config.read().await;
    let s = app_ctx.state.lock().await;

    let status_text = match &s.status {
        SyncStatus::Idle => {
            if cfg.is_configured() {
                "Synchronisiert".to_string()
            } else {
                "Nicht eingerichtet".to_string()
            }
        }
        SyncStatus::Syncing => "Synchronisiere…".to_string(),
        SyncStatus::Paused => "Pausiert".to_string(),
        SyncStatus::Error(e) => format!("Fehler: {}", e),
    };

    Ok(ClientStatusPayload {
        status: s.status.clone(),
        status_text,
        is_configured: cfg.is_configured(),
        local_path: cfg.local_path.clone(),
        server_url: cfg.server_url.clone(),
        last_sync_time: s.last_sync_time,
        progress: s.progress.clone(),
        quota: s.quota.clone(),
        cloud_folders: s.cloud_folders.clone(),
        recent_activities: s.activities.clone(),
    })
}

#[tauri::command]
async fn get_config(app_ctx: State<'_, AppContext>) -> Result<SyncConfig, String> {
    let cfg = app_ctx.config.read().await;
    Ok(cfg.clone())
}

#[tauri::command]
async fn save_config(
    new_config: SyncConfig,
    app_ctx: State<'_, AppContext>,
) -> Result<String, String> {
    new_config.save()?;
    let mut cfg = app_ctx.config.write().await;
    *cfg = new_config.clone();
    let _ = app_ctx.trigger_tx.send(()).await;
    Ok("Einstellungen erfolgreich gespeichert.".to_string())
}

#[tauri::command]
async fn test_connection(
    server_url: String,
    username: String,
    password_or_token: String,
) -> Result<String, String> {
    let client = PureCloudApiClient::new(&server_url, &username, &password_or_token)?;
    client.test_connection().await
}

#[tauri::command]
async fn trigger_sync(app_ctx: State<'_, AppContext>) -> Result<(), String> {
    let _ = app_ctx.trigger_tx.send(()).await;
    Ok(())
}

#[tauri::command]
async fn toggle_pause(app_ctx: State<'_, AppContext>) -> Result<bool, String> {
    let mut cfg = app_ctx.config.write().await;
    cfg.is_paused = !cfg.is_paused;
    let paused = cfg.is_paused;
    let _ = cfg.save();

    let mut s = app_ctx.state.lock().await;
    s.status = if paused {
        s.progress = None;
        SyncStatus::Paused
    } else {
        SyncStatus::Idle
    };

    if !paused {
        let _ = app_ctx.trigger_tx.send(()).await;
    }

    Ok(paused)
}

#[tauri::command]
async fn open_local_folder(app_ctx: State<'_, AppContext>, subpath: Option<String>) -> Result<(), String> {
    let cfg = app_ctx.config.read().await;
    let mut p = std::path::PathBuf::from(&cfg.local_path);
    if let Some(sub) = subpath {
        let clean = sub.trim_start_matches('/');
        if !clean.is_empty() {
            p = p.join(clean);
        }
    }
    if !p.exists() {
        let _ = std::fs::create_dir_all(&p);
    }
    open::that(p).map_err(|e| format!("Konnte Ordner nicht öffnen: {}", e))
}

#[tauri::command]
async fn set_folder_sync_mode(
    path: String,
    mode: String,
    app_ctx: State<'_, AppContext>,
) -> Result<(), String> {
    let mut cfg = app_ctx.config.write().await;
    cfg.folder_rules.insert(path, mode);
    let _ = cfg.save();
    let _ = app_ctx.trigger_tx.send(()).await;
    Ok(())
}

#[tauri::command]
async fn open_web_url(app_ctx: State<'_, AppContext>) -> Result<(), String> {
    let cfg = app_ctx.config.read().await;
    if !cfg.server_url.is_empty() {
        open::that(&cfg.server_url).map_err(|e| format!("Konnte Browser nicht öffnen: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    Ok(())
}

pub fn run() {
    let initial_config = SyncConfig::load();
    let shared_state: SharedState = Arc::new(tokio::sync::Mutex::new(InnerState::default()));
    let (trigger_tx, trigger_rx) = tokio::sync::mpsc::channel(10);
    let stop_flag = Arc::new(AtomicBool::new(false));

    let config_lock = Arc::new(tokio::sync::RwLock::new(initial_config));

    // Spawn Background Sync Engine
    let c_lock = Arc::clone(&config_lock);
    let s_state = Arc::clone(&shared_state);
    let s_flag = Arc::clone(&stop_flag);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio Runtime");
        rt.block_on(async {
            SyncEngine::run_loop(c_lock, s_state, trigger_rx, s_flag).await;
        });
    });

    let app_context = AppContext {
        config: config_lock,
        state: shared_state,
        trigger_tx,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_context)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Fenster nicht beenden, sondern in den System-Tray minimieren
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Build Tray Menu
            let tray_status = MenuItem::with_id(app, "tray_status", "PureCloud: Bereit", false, None::<&str>)?;
            let tray_sync = MenuItem::with_id(app, "tray_sync", "🔄 Jetzt synchronisieren", true, None::<&str>)?;
            let tray_folder = MenuItem::with_id(app, "tray_folder", "📂 Lokalen Ordner öffnen", true, None::<&str>)?;
            let tray_web = MenuItem::with_id(app, "tray_web", "🌐 PureCloud im Web öffnen", true, None::<&str>)?;
            let tray_settings = MenuItem::with_id(app, "tray_settings", "⚙️ Einstellungen anzeigen", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(app, "tray_quit", "❌ Beenden", true, None::<&str>)?;

            let tray_menu = Menu::with_items(
                app,
                &[
                    &tray_status,
                    &tray_sync,
                    &tray_folder,
                    &tray_web,
                    &tray_settings,
                    &tray_quit,
                ],
            )?;

            let _tray = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("PureCloud Sync Client")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_sync" => {
                        let ctx = app.state::<AppContext>();
                        let tx = ctx.trigger_tx.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = tx.send(()).await;
                        });
                    }
                    "tray_folder" => {
                        let ctx = app.state::<AppContext>();
                        let cfg_lock = ctx.config.clone();
                        tauri::async_runtime::spawn(async move {
                            let cfg = cfg_lock.read().await;
                            let _ = open::that(&cfg.local_path);
                        });
                    }
                    "tray_web" => {
                        let ctx = app.state::<AppContext>();
                        let cfg_lock = ctx.config.clone();
                        tauri::async_runtime::spawn(async move {
                            let cfg = cfg_lock.read().await;
                            if !cfg.server_url.is_empty() {
                                let _ = open::that(&cfg.server_url);
                            }
                        });
                    }
                    "tray_settings" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "tray_quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let is_visible = win.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_config,
            save_config,
            test_connection,
            trigger_sync,
            toggle_pause,
            open_local_folder,
            set_folder_sync_mode,
            hide_to_tray,
            open_web_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
