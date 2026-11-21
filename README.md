# ☁️ PureCloud — Schlanke, autarke Datei-Cloud (PHP 8.1+ & SQLite)

Fokussierte, extrem schnelle und zu **100 % autarke** selbstgehostete Datei-Cloud ohne externe Abhängigkeiten. Läuft auf jedem Webspace oder Server sofort ohne externen Datenbank-Server dank **SQLite (WAL-Modus)** und einer reaktionsschnellen **Single-Page-Oberfläche (Vanilla JS)**.

---

## ✨ Kernfunktionen

1. **📁 Moderne Dateiverwaltung (SPA ohne Seiten-Reload)**
   - **3 Ansichten:** Listenansicht (`☰`), kompakte Kachelansicht (`⊞`) und **Zweifenstermodus / Split-View (`◫`)** zum direkten Verschieben/Kopieren zwischen zwei Ordnern.
   - **Excel-artige Sortierung & Filterung:** Klick auf Spaltenköpfe (`Name`, `Größe`, `Geändert`) zum Sortieren sowie integrierter Typ- und Echtzeit-Dateinamen-Filter (`▾ Filter`).
   - **Rechtsklick- & Mobile Long-Touch-Kontextmenü:** Inkl. `📋 Kopieren` / `✂️ Ausschneiden` / `📥 Einfügen` (`Strg+C`/`Strg+X`/`Strg+V`) sowie **Touch-Drag-&-Drop** auf Smartphones.
   - **Selektiver Rückgängig-Verlauf (`↩️`):** Jede Datei-Aktion (Verschieben, Kopieren, Umbenennen, Löschen, Neuer Ordner) lässt sich über das Verlaufs-Dropdown auch unabhängig von der Chronologie einzeln rückgängig machen.
   - **Chunked-Upload (2-MB-Blöcke):** Problemloser Upload beliebig großer Dateien sowie ganzer Ordnerstrukturen per Drag & Drop (selbst bei strikten Shared-Hosting-Limits).
   - **Vorschau & Editor:** Direkte Browser-Vorschau für Bilder (inkl. automatischer 240×240 WebP/JPEG-Thumbnails), Video/Audio (`HTTP 206 Partial Content` Streaming), PDF sowie integrierter Text-/Markdown-/Code-Editor.
   - **Farb-Tags (`🎨`) & Dateinotizen (`📝`):** 6 dezente Farbmarkierungen (Rot, Orange, Gelb, Grün, Blau, Lila) und individuelle Dateinotizen per Kontextmenü, direkt filterbar über die Filterleiste.
   - **Revisionsverlauf / Dateiversionierung (`🕒`):** Bis zu 10 Vorversionen pro Datei automatisch archiviert (beim Überschreiben oder Speichern im Editor), mit 1-Klick-Download oder Wiederherstellung.
   - **Upload-Konflikt-Behandlung (`⚠️`):** Bei Namenskonflikten wahlweise *Überschreiben* (sichert bisherige Version), *Beide behalten* (automatische Nummerierung) oder *Überspringen*.
   - **ZIP-Werkzeuge:** ZIP-Archive im Browser inspizieren, direkt auf dem Server entpacken (inkl. Zip-Slip-, Symlink- & ZIP-Bomben-Schutz) oder beliebige Ordner/Dateien als `.zip` herunterladen.

2. **🔒 AES-256-GCM Zero-Knowledge Tresor (Dateien & ganze Ordner)**
   - Einzelne Dateien oder **komplette Ordnerstrukturen (rekursiv)** lassen sich mit einem persönlichen Passwort (`PBKDF2-HMAC-SHA256`, 100.000 Iterationen, 96-Bit IV, 128-Bit Auth-Tag) verschlüsseln – auch direkt per Drag & Drop auf `🔒 Tresor`.
   - Entschlüsselung entweder dauerhaft oder *on-the-fly* beim einmaligen Download.

3. **👪 Benutzergruppen & Gruppenordner (wie in Nextcloud)**
   - **Benutzergruppen (`⚙️ Admin` → `👪 Gruppen`):** Beliebig viele Teams/Gruppen anlegen und Mitglieder zuweisen.
   - **Zentrale Gruppenordner (`⚙️ Admin` → `📂 Gruppenordner`):** Vom Administrator angelegte Gruppenordner werden für alle Mitglieder der zugewiesenen Gruppe(n) automatisch im Sammelordner **`📁 Gruppenordner`** bereitgestellt (geschützt vor versehentlichem Löschen oder Umbenennen).

4. **🔗 Teilen per Link & Interne Freigaben**
   - **Öffentliche Links (`share.php`):** Optional mit Passwort, Ablaufdatum, Download-Limit und 3 Ordner-Modi (*Nur Download*, *Digitaler Briefkasten / File-Drop* oder *Lesen & Hochladen*).
   - **Interne Freigaben:** Ordner und Dateien gezielt für einzelne Cloud-Benutzer oder ganze Benutzergruppen mit *Lese-* oder *Schreibrecht* freigeben.

5. **🛡️ Gehärtete Sicherheit & 2-Faktor-Authentifizierung (2FA)**
   - **3 kombinierbare 2FA-Methoden:**
     - **📱 Authenticator-App (TOTP, RFC 6238)** inkl. **100 % lokaler SVG-QR-Code-Generierung** (keine Datenweitergabe an externe QR-Server).
     - **🔑 Biometrie / Passkeys (WebAuthn):** Fingerabdruck, FaceID oder Windows Hello.
     - **✉️ E-Mail-Sicherheitscode** mit 2-stufiger Verifizierung vor Aktivierung.
   - **30 Tage „Angemeldet bleiben“** über kryptografisch gehashte Selector/Validator-Tokens (`SHA-256`).
   - **Brute-Force-Rate-Limiting**, strikte `Content-Security-Policy` (Sandbox gegen Stored XSS) und eigene **WebDAV-App-Passwörter**.

6. **📡 Native WebDAV-Schnittstelle (`webdav.php`) & PWA**
   - Direkt als Netzlaufwerk im Windows Explorer, macOS Finder, unter Linux (`davfs2`/GNOME/KDE) oder auf dem Smartphone einbindbar.
   - Installierbar als **Progressive Web App (PWA)** auf Desktop, Android und iOS.

---

## 🚀 Installation

### Auf jedem Webspace / Server (Apache / Nginx)
Einfach den gesamten Projektinhalt in das gewünschte Webverzeichnis hochladen. Beim ersten Aufruf im Browser legt [`src/Database.php`](src/Database.php) das Verzeichnis `storage/` (inkl. `.htaccess`-Schutz und SQLite-Datenbank) **vollautomatisch** an und zeigt den Einrichtungsdialog für das erste Administrator-Konto.

### Lokal testen
```bash
chmod +x start.sh
./start.sh 8080
```
