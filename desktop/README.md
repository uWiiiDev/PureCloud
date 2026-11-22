# ☁️ PureCloud Desktop Sync Client (Tauri 2.0)

Ein extrem schlanker, nativer und ressourcenschonender Desktop-Synchronisations-Client für **PureCloud**, entwickelt auf Basis von **Tauri 2.0 (Rust)**.

Unterstützt **Linux**, **Windows** und **macOS** gleichermaßen – mit einem Speicherverbrauch von nur ca. 15–25 MB RAM (im Vergleich zu ~120 MB bei Electron-basierten Clients).

---

## ✨ Kernfunktionen

* 🔄 **Bidirektionale Echtzeit-Synchronisation:**  
  Dateisystem-Überwachung über native OS-Events (`notify`). Neue, geänderte oder gelöschte Dateien werden sofort erkannt und abgeglichen.
* 🛡️ **Automatische Konfliktbehandlung:**  
  Wird eine Datei lokal und gleichzeitig auf dem Server bearbeitet, wird die lokale Datei sicher als `Dateiname (Konflikt JJJJ-MM-TT HH-MM).ext` archiviert – kein Datenverlust.
* 🖥️ **System-Tray-Integration:**  
  Statusanzeige in der Taskleiste (neben der Uhr) mit Direktaktionen:
  * Statusanzeige (*Synchronisiert*, *Synchronisiere…*, *Pausiert*, *Fehler*)
  * *🔄 Jetzt synchronisieren*
  * *📂 Lokalen Ordner im Dateimanager öffnen*
  * *🌐 PureCloud im Web-Browser öffnen*
  * *Einstellungen & Beenden*
* 📊 **Speicher-Quota & Aktivitäten-Stream:**  
  Visueller Balken mit belegtem und freiem Speicherplatz sowie eine Live-Historie aller übertragenen Dateien.
* 🌓 **Hell- & Dunkelmodus:**  
  Nahtlos an das Design der PureCloud Web-Oberfläche angepasst.
* 🚀 **Keine schweren Node/Electron-Abhängigkeiten:**  
  Das Frontend nutzt performantes Vanilla HTML/CSS/JS und kommuniziert direkt über die native Tauri-Bridge mit dem Rust-Kern.

---

## 📁 Projektstruktur

```
desktop/
├── src-tauri/
│   ├── Cargo.toml              # Rust-Abhängigkeiten (Tauri 2.0, Tokio, Notify, Reqwest)
│   ├── tauri.conf.json         # Tauri 2.0 Konfiguration (Fenster, Tray, App-ID)
│   ├── build.rs                # Build-Skript
│   ├── capabilities/
│   │   └── default.json        # Tauri 2 Rechteverwaltung
│   ├── icons/                  # App- und Tray-Icons
│   └── src/
│       ├── main.rs             # Einstiegspunkt
│       ├── lib.rs              # Tauri-Commands & System-Tray
│       ├── config.rs           # Konfigurationsmanager (~/.config/purecloud/config.json)
│       ├── state.rs            # Thread-sicherer Shared Application State
│       └── sync/
│           ├── mod.rs          # SyncEngine-Orchestrierung
│           ├── api.rs          # PureCloud HTTP & WebDAV Client
│           ├── watcher.rs      # Dateisystem-Watcher (notify)
│           └── conflict.rs     # Konflikterkennung und -auflösung
└── ui/
    ├── index.html              # Dashboard & Einrichtungsassistent
    ├── app.js                  # Frontend-Controller & Tauri-Bindings
    └── style.css               # Modernes PureCloud-Design (Dark/Light)
```

---

## 🛠️ Bauen & Starten

### 1. Voraussetzungen installieren

#### Linux (Debian / Ubuntu / Mint):
```bash
# Systempakete für WebKit und AppIndicator
sudo apt update
sudo apt install -y build-essential curl wget file libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev

# Rust installieren (falls noch nicht vorhanden)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Tauri 2 CLI installieren
cargo install tauri-cli --version "^2.0"
```

#### Windows:
* [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
* [Rust](https://www.rust-lang.org/tools/install)
* `cargo install tauri-cli --version "^2.0"`

#### macOS:
* Xcode Command Line Tools: `xcode-select --install`
* [Rust](https://www.rust-lang.org/tools/install)
* `cargo install tauri-cli --version "^2.0"`

---

### 2. Entwicklung starten (Live-Reload)

```bash
cd desktop/src-tauri
cargo tauri dev
```

---

### 3. Produktionsreife Installationspakete bauen

Führen Sie folgenden Befehl im Verzeichnis `desktop/src-tauri` aus:

```bash
cargo tauri build
```

Die fertigen Installationspakete liegen anschließend unter:
* **Linux:** `target/release/bundle/deb/` (`.deb`) und `target/release/bundle/appimage/` (`.AppImage`)
* **Windows:** `target/release/bundle/msi/` (`.msi`) und `target/release/bundle/nsis/` (`.exe`)
* **macOS:** `target/release/bundle/dmg/` (`.dmg`) und `.app`
