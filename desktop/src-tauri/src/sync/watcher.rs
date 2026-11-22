use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use tokio::sync::mpsc::Sender;

pub struct LocalFileWatcher {
    _watcher: RecommendedWatcher,
}

impl LocalFileWatcher {
    pub fn start<P: AsRef<Path>>(
        sync_dir: P,
        change_notify_tx: Sender<PathBuf>,
    ) -> Result<Self, String> {
        let (tx, rx) = channel();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Fehler beim Initialisieren des Dateisystem-Watchers: {}", e))?;

        let path = sync_dir.as_ref();
        if !path.exists() {
            let _ = std::fs::create_dir_all(path);
        }

        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| format!("Konnte Ordner {} nicht überwachen: {}", path.display(), e))?;

        // Background thread to filter events and send debounced notifications
        std::thread::spawn(move || {
            while let Ok(event) = rx.recv() {
                for p in event.paths {
                    let filename = p.file_name().unwrap_or_default().to_string_lossy();
                    // Ignore hidden files and temp files
                    if filename.starts_with('.')
                        || filename.ends_with(".tmp")
                        || filename.ends_with(".part")
                        || filename.ends_with(".crdownload")
                        || filename.contains("~")
                    {
                        continue;
                    }

                    let _ = change_notify_tx.try_send(p);
                }
            }
        });

        Ok(Self { _watcher: watcher })
    }
}
