use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFileItem {
    pub id: i64,
    pub name: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub is_folder: bool,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct PureCloudApiClient {
    client: Client,
    server_base_url: String,
    auth_header_val: String,
}

impl PureCloudApiClient {
    pub fn new(server_url: &str, username: &str, password_or_token: &str) -> Result<Self, String> {
        let base = server_url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err("Ungültige Server-URL".to_string());
        }

        let basic_token = base64_encode(&format!("{}:{}", username.trim(), password_or_token.trim()));
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Basic {}", basic_token))
                .map_err(|e| e.to_string())?,
        );
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static("PureCloud-Desktop-Client/1.0"),
        );

        let client = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Fehler beim Initialisieren des HTTP-Clients: {}", e))?;

        Ok(Self {
            client,
            server_base_url: base,
            auth_header_val: format!("Basic {}", basic_token),
        })
    }

    pub async fn test_connection(&self) -> Result<String, String> {
        let url = format!("{}/webdav.php", self.server_base_url);
        let resp = self
            .client
            .request(reqwest::Method::from_bytes(b"OPTIONS").unwrap(), &url)
            .send()
            .await
            .map_err(|e| format!("Verbindungsfehler zu {}: {}", url, e))?;

        if resp.status().is_success() || resp.status() == reqwest::StatusCode::OK {
            Ok("Verbindung erfolgreich hergestellt.".to_string())
        } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            Err("Authentifizierung fehlgeschlagen: Benutzername oder Passwort/Token ungültig.".to_string())
        } else {
            Err(format!("Server antwortete mit Status: {}", resp.status()))
        }
    }

    pub async fn get_storage_quota(&self) -> Result<(u64, u64), String> {
        // Query user info or settings
        let url = format!("{}/api.php?action=current_user", self.server_base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().is_success() {
            #[derive(Deserialize)]
            struct UserResp {
                user: Option<UserData>,
            }
            #[derive(Deserialize)]
            struct UserData {
                used_bytes: Option<u64>,
                quota_bytes: Option<u64>,
            }

            if let Ok(data) = resp.json::<UserResp>().await {
                if let Some(u) = data.user {
                    let used = u.used_bytes.unwrap_or(0);
                    let quota = u.quota_bytes.unwrap_or(0);
                    return Ok((used, quota));
                }
            }
        }
        Ok((0, 0))
    }

    pub async fn download_file(&self, remote_rel_path: &str, local_dest: &Path) -> Result<u64, String> {
        let safe_rel = remote_rel_path.trim_start_matches('/');
        let url = format!("{}/webdav.php/{}", self.server_base_url, safe_rel);

        let resp = self.client.get(&url).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!(
                "Download fehlgeschlagen (HTTP {}): {}",
                resp.status(),
                remote_rel_path
            ));
        }

        if let Some(parent) = local_dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }

        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let len = bytes.len() as u64;

        tokio::fs::write(local_dest, bytes)
            .await
            .map_err(|e| e.to_string())?;

        Ok(len)
    }

    pub async fn upload_file(&self, local_src: &Path, remote_rel_path: &str) -> Result<u64, String> {
        let safe_rel = remote_rel_path.trim_start_matches('/');
        let url = format!("{}/webdav.php/{}", self.server_base_url, safe_rel);

        let content = tokio::fs::read(local_src)
            .await
            .map_err(|e| format!("Konnte lokale Datei nicht lesen: {}", e))?;
        let len = content.len() as u64;

        let resp = self
            .client
            .put(&url)
            .body(content)
            .send()
            .await
            .map_err(|e| format!("Upload-Fehler: {}", e))?;

        if resp.status().is_success() || resp.status() == reqwest::StatusCode::CREATED || resp.status() == reqwest::StatusCode::NO_CONTENT {
            Ok(len)
        } else {
            Err(format!(
                "Upload fehlgeschlagen (HTTP {}): {}",
                resp.status(),
                remote_rel_path
            ))
        }
    }

    pub async fn create_remote_folder(&self, remote_rel_path: &str) -> Result<(), String> {
        let safe_rel = remote_rel_path.trim_start_matches('/');
        let url = format!("{}/webdav.php/{}", self.server_base_url, safe_rel);

        let resp = self
            .client
            .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().is_success() || resp.status() == reqwest::StatusCode::CREATED || resp.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            Ok(())
        } else {
            Err(format!("Konnte Ordner nicht erstellen (HTTP {})", resp.status()))
        }
    }

    pub async fn delete_remote_item(&self, remote_rel_path: &str) -> Result<(), String> {
        let safe_rel = remote_rel_path.trim_start_matches('/');
        let url = format!("{}/webdav.php/{}", self.server_base_url, safe_rel);

        let resp = self.client.delete(&url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(format!("Löschen fehlgeschlagen (HTTP {})", resp.status()))
        }
    }
}

fn base64_encode(input: &str) -> String {
    use std::io::Write;
    let mut buf = Vec::new();
    {
        // Simple base64 encoder without external dependency
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes = input.as_bytes();
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

            let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
            buf.push(CHARS[((n >> 18) & 63) as usize]);
            buf.push(CHARS[((n >> 12) & 63) as usize]);
            if chunk.len() > 1 {
                buf.push(CHARS[((n >> 6) & 63) as usize]);
            } else {
                buf.push(b'=');
            }
            if chunk.len() > 2 {
                buf.push(CHARS[(n & 63) as usize]);
            } else {
                buf.push(b'=');
            }
        }
    }
    String::from_utf8(buf).unwrap_or_default()
}
