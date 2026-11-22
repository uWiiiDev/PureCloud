use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SyncStatus {
    Idle,
    Syncing,
    Paused,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub current_file: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncActivityItem {
    pub id: String,
    pub path: String,
    pub action: String, // "upload", "download", "delete", "conflict"
    pub size_bytes: u64,
    pub timestamp: DateTime<Utc>,
    pub status: String, // "success", "error"
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub used_percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudFolderSummary {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientStatusPayload {
    pub status: SyncStatus,
    pub status_text: String,
    pub is_configured: bool,
    pub local_path: String,
    pub server_url: String,
    pub last_sync_time: Option<DateTime<Utc>>,
    pub progress: Option<SyncProgress>,
    pub quota: Option<QuotaInfo>,
    pub cloud_folders: Vec<CloudFolderSummary>,
    pub recent_activities: Vec<SyncActivityItem>,
}

pub struct InnerState {
    pub status: SyncStatus,
    pub last_sync_time: Option<DateTime<Utc>>,
    pub progress: Option<SyncProgress>,
    pub quota: Option<QuotaInfo>,
    pub cloud_folders: Vec<CloudFolderSummary>,
    pub activities: Vec<SyncActivityItem>,
}

impl Default for InnerState {
    fn default() -> Self {
        Self {
            status: SyncStatus::Idle,
            last_sync_time: None,
            progress: None,
            quota: None,
            cloud_folders: Vec::new(),
            activities: Vec::new(),
        }
    }
}

pub type SharedState = Arc<Mutex<InnerState>>;
