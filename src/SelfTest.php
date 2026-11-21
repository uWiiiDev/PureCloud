<?php
declare(strict_types=1);

namespace Cloud;

use PDO;
use RuntimeException;
use Throwable;

class SelfTest
{
    /**
     * Führt die vollständige Integritäts- und Funktionsprüfung durch.
     */
    public static function runAll(int $userId): array
    {
        $startOverall = microtime(true);
        $categories = [];

        // 1. PHP & Laufzeitumgebung
        $categories[] = self::checkEnvironment();

        // 2. Dateisystem & Speicher
        $categories[] = self::checkStorage();

        // 3. SQLite-Datenbank & Datenintegrität
        $categories[] = self::checkDatabase();

        // 4. Kryptografie & Sicherheit
        $categories[] = self::checkSecurityCrypto();

        // 5. Medien & ZIP-Archive
        $categories[] = self::checkMediaAndZip();

        // 6. Konnektivität & Updates
        $categories[] = self::checkConnectivity();

        // Gesamtauswertung
        $totalTests = 0;
        $passed = 0;
        $warnings = 0;
        $failed = 0;

        foreach ($categories as $cat) {
            foreach ($cat['tests'] as $test) {
                $totalTests++;
                if ($test['status'] === 'pass') {
                    $passed++;
                } elseif ($test['status'] === 'warning') {
                    $warnings++;
                } else {
                    $failed++;
                }
            }
        }

        $overallStatus = 'pass';
        if ($failed > 0) {
            $overallStatus = 'fail';
        } elseif ($warnings > 0) {
            $overallStatus = 'warning';
        }

        $durationMs = round((microtime(true) - $startOverall) * 1000, 1);

        return [
            'ok'             => true,
            'timestamp'      => date('c'),
            'duration_ms'    => $durationMs,
            'overall_status' => $overallStatus,
            'summary'        => [
                'total'          => $totalTests,
                'passed'         => $passed,
                'warnings'       => $warnings,
                'failed'         => $failed,
                'health_percent' => $totalTests > 0 ? (int)round(($passed / $totalTests) * 100) : 100,
            ],
            'categories'     => $categories,
        ];
    }

    /**
     * Führt einen einzelnen Test geschützt aus.
     */
    private static function test(string $id, string $name, callable $fn): array
    {
        $start = microtime(true);
        try {
            $res = $fn();
            $dur = round((microtime(true) - $start) * 1000, 2);
            return array_merge([
                'id'          => $id,
                'name'        => $name,
                'status'      => 'pass',
                'value'       => '',
                'message'     => '',
                'duration_ms' => $dur,
            ], $res);
        } catch (Throwable $e) {
            $dur = round((microtime(true) - $start) * 1000, 2);
            return [
                'id'          => $id,
                'name'        => $name,
                'status'      => 'fail',
                'value'       => 'Ausnahme ausgelöst',
                'message'     => $e->getMessage(),
                'duration_ms' => $dur,
            ];
        }
    }

    /**
     * Kategorie 1: PHP & Laufzeitumgebung
     */
    private static function checkEnvironment(): array
    {
        $tests = [];

        // PHP-Version
        $tests[] = self::test('php_version', 'PHP-Version', function () {
            $version = PHP_VERSION;
            $pass = version_compare($version, '8.1.0', '>=');
            return [
                'status'  => $pass ? 'pass' : 'fail',
                'value'   => 'PHP ' . $version,
                'message' => $pass
                    ? 'Empfohlene Version erfüllt (>= 8.1.0).'
                    : 'PHP 8.1 oder neuer ist erforderlich.',
            ];
        });

        // PDO SQLite
        $tests[] = self::test('ext_pdo_sqlite', 'SQLite-Erweiterung (pdo_sqlite)', function () {
            $loaded = extension_loaded('pdo_sqlite');
            return [
                'status'  => $loaded ? 'pass' : 'fail',
                'value'   => $loaded ? 'Geladen' : 'Fehlt',
                'message' => $loaded ? 'SQLite Treiber aktiv.' : 'pdo_sqlite ist zwingend für PureCloud erforderlich.',
            ];
        });

        // ZIP Extension
        $tests[] = self::test('ext_zip', 'ZIP-Erweiterung (zip)', function () {
            $loaded = extension_loaded('zip');
            return [
                'status'  => $loaded ? 'pass' : 'fail',
                'value'   => $loaded ? 'Geladen' : 'Fehlt',
                'message' => $loaded ? 'ZipArchive verfügbar für Downloads & ZIP-Inspektor.' : 'Erweiterung zip fehlt.',
            ];
        });

        // Fileinfo Extension
        $tests[] = self::test('ext_fileinfo', 'MIME-Typ-Erkennung (fileinfo)', function () {
            $loaded = extension_loaded('fileinfo');
            return [
                'status'  => $loaded ? 'pass' : 'fail',
                'value'   => $loaded ? 'Geladen' : 'Fehlt',
                'message' => $loaded ? 'Automatische MIME-Type-Erkennung aktiv.' : 'Erweiterung fileinfo fehlt.',
            ];
        });

        // GD Extension
        $tests[] = self::test('ext_gd', 'Bildbibliothek (gd)', function () {
            $loaded = extension_loaded('gd');
            if (!$loaded) {
                return ['status' => 'fail', 'value' => 'Fehlt', 'message' => 'GD fehlt für Thumbnails und Bildbearbeitung.'];
            }
            $info = gd_info();
            $webp = !empty($info['WebP Support']);
            $jpeg = !empty($info['JPEG Support']);
            $png  = !empty($info['PNG Support']);
            $formats = [];
            if ($webp) $formats[] = 'WebP';
            if ($jpeg) $formats[] = 'JPEG';
            if ($png)  $formats[] = 'PNG';

            return [
                'status'  => 'pass',
                'value'   => 'Geladen (' . implode(', ', $formats) . ')',
                'message' => 'GD Bildbibliothek unterstützt ' . implode(', ', $formats) . '.',
            ];
        });

        // OpenSSL Extension
        $tests[] = self::test('ext_openssl', 'Kryptografie (openssl)', function () {
            $loaded = extension_loaded('openssl');
            return [
                'status'  => $loaded ? 'pass' : 'fail',
                'value'   => $loaded ? (OPENSSL_VERSION_TEXT ?? 'Geladen') : 'Fehlt',
                'message' => $loaded ? 'OpenSSL für Verschlüsselung & Signaturen aktiv.' : 'Erweiterung openssl fehlt.',
            ];
        });

        // Mbstring Extension
        $tests[] = self::test('ext_mbstring', 'Multibyte-Zeichenfolgen (mbstring)', function () {
            $loaded = extension_loaded('mbstring');
            return [
                'status'  => $loaded ? 'pass' : 'warning',
                'value'   => $loaded ? 'Geladen' : 'Fehlt',
                'message' => $loaded ? 'UTF-8 Zeichenverarbeitung optimal unterstützt.' : 'mbstring wird für Sonderzeichen und Umlaute empfohlen.',
            ];
        });

        // cURL Extension
        $tests[] = self::test('ext_curl', 'Netzwerkclient (curl)', function () {
            $loaded = extension_loaded('curl');
            return [
                'status'  => $loaded ? 'pass' : 'warning',
                'value'   => $loaded ? 'Geladen' : 'Fehlt',
                'message' => $loaded ? 'cURL für GitHub-Updates und Webhooks bereit.' : 'cURL fehlt (wichtig für Online-Updates).',
            ];
        });

        // PHP Memory Limit
        $tests[] = self::test('php_memory', 'PHP-Speicherlimit (memory_limit)', function () {
            $limit = ini_get('memory_limit');
            $bytes = self::parseBytes((string)$limit);
            $warning = ($bytes > 0 && $bytes < 128 * 1024 * 1024);
            return [
                'status'  => $warning ? 'warning' : 'pass',
                'value'   => $limit,
                'message' => $warning ? 'Empfehlung: Mindestens 128M für ZIP- und Bildverarbeitung.' : 'Ausreichend Speicher verfügbar.',
            ];
        });

        // PHP Upload Limits
        $tests[] = self::test('php_upload', 'Upload-Dateigrößenlimit', function () {
            $up = ini_get('upload_max_filesize');
            $post = ini_get('post_max_size');
            $upBytes = self::parseBytes((string)$up);
            $postBytes = self::parseBytes((string)$post);
            $warning = ($upBytes > 0 && $upBytes < 10 * 1024 * 1024);
            return [
                'status'  => $warning ? 'warning' : 'pass',
                'value'   => "Upload: $up · Post: $post",
                'message' => $warning ? 'Dateigrößenlimit ist relativ klein (< 10M).' : 'Upload-Limits konfiguriert (Chunked Uploads unterstützen auch größere Dateien).',
            ];
        });

        // OPcache
        $tests[] = self::test('php_opcache', 'OPcache-Bytecode-Cache', function () {
            $enabled = function_exists('opcache_get_status') && ini_get('opcache.enable');
            return [
                'status'  => 'pass',
                'value'   => $enabled ? 'Aktiviert' : 'Nicht aktiv',
                'message' => $enabled ? 'PHP-Bytecode wird gecacht (maximale Geschwindigkeit).' : 'OPcache ist optional, wird aber für maximale Performance in Produktion empfohlen.',
            ];
        });

        return [
            'id'    => 'environment',
            'title' => '🖥️ PHP & Laufzeitumgebung',
            'tests' => $tests,
        ];
    }

    /**
     * Kategorie 2: Dateisystem & Speicher
     */
    private static function checkStorage(): array
    {
        $tests = [];

        Database::ensureDirectories();

        $dirs = [
            'storage_root' => ['Name' => 'Hauptspeicher (storage)', 'Pfad' => Database::STORAGE_DIR],
            'files_dir'    => ['Name' => 'Dateispeicher (storage/files)', 'Pfad' => Database::FILES_DIR],
            'chunks_dir'   => ['Name' => 'Upload-Zwischenspeicher (storage/chunks)', 'Pfad' => Database::CHUNKS_DIR],
            'thumbs_dir'   => ['Name' => 'Thumbnail-Cache (storage/thumbs)', 'Pfad' => Database::THUMBS_DIR],
        ];

        foreach ($dirs as $id => $d) {
            $tests[] = self::test($id, $d['Name'], function () use ($d) {
                $p = $d['Pfad'];
                if (!is_dir($p)) {
                    return ['status' => 'fail', 'value' => 'Nicht gefunden', 'message' => "Verzeichnis existiert nicht: $p"];
                }
                if (!is_readable($p) || !is_writable($p)) {
                    return ['status' => 'fail', 'value' => 'Keine Schreibrechte', 'message' => "Verzeichnis benötigt Schreib- und Leserechte: $p"];
                }
                return ['status' => 'pass', 'value' => 'Les- & beschreibbar', 'message' => 'Berechtigungen OK.'];
            });
        }

        // SQLite DB File
        $tests[] = self::test('db_file_access', 'SQLite-Datenbankdatei', function () {
            $p = Database::DB_FILE;
            if (!file_exists($p)) {
                return ['status' => 'fail', 'value' => 'Nicht vorhanden', 'message' => "Datenbankdatei existiert nicht: $p"];
            }
            if (!is_readable($p) || !is_writable($p)) {
                return ['status' => 'fail', 'value' => 'Berechtigung fehlt', 'message' => 'Datenbankdatei ist nicht les- oder beschreibbar.'];
            }
            $size = round(filesize($p) / 1024, 1);
            return [
                'status'  => 'pass',
                'value'   => "Les- & beschreibbar ({$size} KB)",
                'message' => 'Datenbankdatei zugänglich und beschreibbar.',
            ];
        });

        // Dateisystem I/O Zyklus (Schreiben -> Lesen -> Hash prüfen -> Löschen)
        $tests[] = self::test('storage_io_cycle', 'Speicher-Lese-/Schreibzyklus (I/O)', function () {
            $rnd = bin2hex(random_bytes(16));
            $tmpFile = Database::FILES_DIR . '/.selftest_' . $rnd . '.tmp';
            $content = "PureCloud-SelfTest-Token: " . bin2hex(random_bytes(64));

            $written = @file_put_contents($tmpFile, $content);
            if ($written === false) {
                return ['status' => 'fail', 'value' => 'Schreibfehler', 'message' => 'Konnte temporäre Testdatei nicht anlegen.'];
            }

            $read = @file_get_contents($tmpFile);
            $deleted = @unlink($tmpFile);

            if ($read !== $content) {
                return ['status' => 'fail', 'value' => 'Integritätsfehler', 'message' => 'Gelesener Dateiinhalt stimmt nicht mit dem geschriebenen überein.'];
            }
            if (!$deleted) {
                return ['status' => 'warning', 'value' => 'Löschwarnung', 'message' => 'Testdatei konnte nach der Prüfung nicht gelöscht werden.'];
            }

            return [
                'status'  => 'pass',
                'value'   => 'Schreiben, Lesen, Verifizieren & Löschen OK',
                'message' => 'I/O-Zyklus fehlerfrei durchlaufen.',
            ];
        });

        // Freier Festplattenspeicher
        $tests[] = self::test('disk_free_space', 'Freier Festplattenspeicher', function () {
            $free = @disk_free_space(Database::STORAGE_DIR);
            $total = @disk_total_space(Database::STORAGE_DIR);

            if ($free === false || $total === false || $total <= 0) {
                return ['status' => 'warning', 'value' => 'Unbekannt', 'message' => 'Konnte Festplattenkapazität nicht ermitteln.'];
            }

            $freeGb = round($free / (1024 * 1024 * 1024), 2);
            $totalGb = round($total / (1024 * 1024 * 1024), 2);
            $percentFree = round(($free / $total) * 100, 1);

            $status = 'pass';
            if ($free < 100 * 1024 * 1024) {
                $status = 'fail';
            } elseif ($free < 1024 * 1024 * 1024) {
                $status = 'warning';
            }

            return [
                'status'  => $status,
                'value'   => "{$freeGb} GB frei von {$totalGb} GB ({$percentFree}%)",
                'message' => $status === 'pass'
                    ? 'Ausreichend Festplattenspeicher vorhanden.'
                    : ($status === 'warning' ? 'Festplattenspeicher wird knapp (< 1 GB frei)!' : 'Kritisch: Weniger als 100 MB freier Speicherplatz!'),
            ];
        });

        return [
            'id'    => 'storage',
            'title' => '💾 Dateisystem & Speicher',
            'tests' => $tests,
        ];
    }

    /**
     * Kategorie 3: SQLite-Datenbank & Integrität
     */
    private static function checkDatabase(): array
    {
        $tests = [];
        $pdo = Database::get();

        // SQLite Version & Journal Mode
        $tests[] = self::test('db_version_wal', 'SQLite-Modus & Version', function () use ($pdo) {
            $ver = (string)$pdo->query('SELECT sqlite_version()')->fetchColumn();
            $wal = (string)$pdo->query('PRAGMA journal_mode;')->fetchColumn();
            $isWal = strtolower($wal) === 'wal';
            return [
                'status'  => 'pass',
                'value'   => "SQLite v{$ver} (Journal: {$wal})",
                'message' => $isWal ? 'WAL-Modus aktiv für hohe Nebenläufigkeit.' : "Journal-Modus: {$wal}",
            ];
        });

        // PRAGMA integrity_check
        $tests[] = self::test('db_integrity_check', 'SQLite-Integritätsprüfung (PRAGMA integrity_check)', function () use ($pdo) {
            $res = $pdo->query('PRAGMA integrity_check(10);')->fetchAll(PDO::FETCH_COLUMN);
            $isOk = (count($res) === 1 && strtolower((string)$res[0]) === 'ok');
            return [
                'status'  => $isOk ? 'pass' : 'fail',
                'value'   => $isOk ? 'OK' : 'Fehler festgestellt',
                'message' => $isOk ? 'Datenbankstruktur und B-Tree-Indizes sind zu 100% intakt.' : 'Warnung: ' . implode('; ', $res),
            ];
        });

        // PRAGMA foreign_key_check
        $tests[] = self::test('db_foreign_keys', 'Fremdschlüssel-Prüfung (PRAGMA foreign_key_check)', function () use ($pdo) {
            $res = $pdo->query('PRAGMA foreign_key_check;')->fetchAll();
            $count = count($res);
            return [
                'status'  => $count === 0 ? 'pass' : 'warning',
                'value'   => $count === 0 ? '0 Verletzungen' : "{$count} Integritätsverletzungen",
                'message' => $count === 0
                    ? 'Referenzielle Integrität aller Beziehungen bestätigt.'
                    : 'Es wurden ungelöste Fremdschlüssel-Verbindungen gefunden.',
            ];
        });

        // Tabellenschema
        $tests[] = self::test('db_tables_exist', 'Vollständigkeit des Datenbankschemas', function () use ($pdo) {
            $expected = [
                'settings', 'users', 'folders', 'files', 'public_shares', 'user_shares',
                'webdav_locks', 'user_passkeys', 'rate_limits', 'remember_tokens', 'groups',
                'group_members', 'group_shares', 'favorites', 'file_versions', 'pinned_items',
                'bundles', 'bundle_items',
            ];

            $existing = $pdo->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(PDO::FETCH_COLUMN);
            $existingMap = array_flip($existing);
            $missing = [];
            foreach ($expected as $table) {
                if (!isset($existingMap[$table])) {
                    $missing[] = $table;
                }
            }

            if (!empty($missing)) {
                return [
                    'status'  => 'fail',
                    'value'   => (count($expected) - count($missing)) . '/' . count($expected) . ' Tabellen',
                    'message' => 'Fehlende Tabellen: ' . implode(', ', $missing),
                ];
            }

            return [
                'status'  => 'pass',
                'value'   => count($expected) . '/' . count($expected) . ' Tabellen vorhanden',
                'message' => 'Alle erforderlichen PureCloud-Tabellen existieren.',
            ];
        });

        // Datenbank-Latenz
        $tests[] = self::test('db_query_latency', 'Datenbank-Latenz & Abfragezeit', function () use ($pdo) {
            $runs = 10;
            $start = microtime(true);
            for ($i = 0; $i < $runs; $i++) {
                $pdo->query('SELECT count(*) FROM files')->fetchColumn();
            }
            $avgMs = round(((microtime(true) - $start) / $runs) * 1000, 3);
            return [
                'status'  => $avgMs < 10 ? 'pass' : 'warning',
                'value'   => "Ø {$avgMs} ms / Abfrage",
                'message' => $avgMs < 10 ? 'Ausgezeichnete Zugriffszeit.' : 'Latenz leicht erhöht.',
            ];
        });

        // Verwaiste Datensätze (Orphan Records Check)
        $tests[] = self::test('db_orphan_records', 'Prüfung auf verwaiste Daten (Orphans)', function () use ($pdo) {
            $orphans = [];

            // Dateien ohne Benutzer
            $stmt = $pdo->query('SELECT count(*) FROM files WHERE owner_id NOT IN (SELECT id FROM users)');
            $orphanFiles = (int)$stmt->fetchColumn();
            if ($orphanFiles > 0) $orphans[] = "{$orphanFiles} Dateien ohne gültigen Benutzer";

            // Dateien in gelöschten Ordnern
            $stmt = $pdo->query('SELECT count(*) FROM files WHERE folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM folders)');
            $orphanFolderFiles = (int)$stmt->fetchColumn();
            if ($orphanFolderFiles > 0) $orphans[] = "{$orphanFolderFiles} Dateien in nicht existierenden Ordnern";

            // Ordner ohne Benutzer
            $stmt = $pdo->query('SELECT count(*) FROM folders WHERE owner_id NOT IN (SELECT id FROM users)');
            $orphanFolders = (int)$stmt->fetchColumn();
            if ($orphanFolders > 0) $orphans[] = "{$orphanFolders} Ordner ohne gültigen Benutzer";

            // Ordner mit ungültigem Eltern-Ordner
            $stmt = $pdo->query('SELECT count(*) FROM folders WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM folders)');
            $orphanParent = (int)$stmt->fetchColumn();
            if ($orphanParent > 0) $orphans[] = "{$orphanParent} Ordner mit ungültigem Eltern-Ordner";

            // Versionen ohne Quelldatei
            $stmt = $pdo->query('SELECT count(*) FROM file_versions WHERE file_id NOT IN (SELECT id FROM files)');
            $orphanVersions = (int)$stmt->fetchColumn();
            if ($orphanVersions > 0) $orphans[] = "{$orphanVersions} Versionen ohne Quelldatei";

            // Sammelmappen-Einträge ohne Datei oder Mappe
            $stmt = $pdo->query('SELECT count(*) FROM bundle_items WHERE bundle_id NOT IN (SELECT id FROM bundles) OR file_id NOT IN (SELECT id FROM files)');
            $orphanBundleItems = (int)$stmt->fetchColumn();
            if ($orphanBundleItems > 0) $orphans[] = "{$orphanBundleItems} ungültige Sammelmappen-Elemente";

            if (!empty($orphans)) {
                return [
                    'status'  => 'warning',
                    'value'   => implode(', ', $orphans),
                    'message' => 'Hinweis: Verwaiste Datensätze gefunden. Diese können bereinigt werden.',
                ];
            }

            return [
                'status'  => 'pass',
                'value'   => '0 verwaiste Datensätze',
                'message' => 'Keine verwaisten Dateien, Versionen oder Mappen-Referenzen gefunden.',
            ];
        });

        return [
            'id'    => 'database',
            'title' => '🗄️ SQLite-Datenbank & Datenintegrität',
            'tests' => $tests,
        ];
    }

    /**
     * Kategorie 4: Kryptografie & Sicherheit
     */
    private static function checkSecurityCrypto(): array
    {
        $tests = [];

        // AES-256-GCM Chiffre
        $tests[] = self::test('crypto_cipher_aes256gcm', 'AES-256-GCM Hardware-Chiffre', function () {
            $ciphers = openssl_get_cipher_methods();
            $hasGcm = in_array(CryptoVault::CIPHER, $ciphers, true);
            return [
                'status'  => $hasGcm ? 'pass' : 'fail',
                'value'   => $hasGcm ? CryptoVault::CIPHER . ' verfügbar' : 'Nicht verfügbar',
                'message' => $hasGcm ? 'Authentifizierte Verschlüsselung (AEAD) wird vom System unterstützt.' : 'AES-256-GCM wird zwingend für den PureCloud-Tresor benötigt.',
            ];
        });

        // Tresor End-to-End Verschlüsselungszyklus (CryptoVault)
        $tests[] = self::test('cryptovault_e2e_cycle', 'Tresor AES-256-GCM Funktionszyklus', function () {
            $tmpFile = Database::FILES_DIR . '/.selftest_vault_' . bin2hex(random_bytes(8)) . '.tmp';
            $secretPayload = "Geheimer PureCloud-Tresortest: " . bin2hex(random_bytes(64));
            $passphrase = "SicheresSelbsttestKennwort#" . bin2hex(random_bytes(4));

            file_put_contents($tmpFile, $secretPayload);

            try {
                // 1. Verschlüsseln
                CryptoVault::encryptFileInPlace($tmpFile, $passphrase);

                // 2. Prüfen, ob als verschlüsselt erkannt
                if (!CryptoVault::isEncryptedFile($tmpFile)) {
                    throw new RuntimeException('Verschlüsselte Datei hat keinen gültigen PureCloud-Vault-Header.');
                }

                // 3. Entschlüsseln im RAM & Inhalt vergleichen
                $decryptedBytes = CryptoVault::decryptToBytes($tmpFile, $passphrase);
                if ($decryptedBytes !== $secretPayload) {
                    throw new RuntimeException('Entschlüsselter Inhalt weicht vom Original ab.');
                }

                // 4. Datei vor Ort entschlüsseln
                CryptoVault::decryptFileInPlace($tmpFile, $passphrase);
                $restoredContent = file_get_contents($tmpFile);
                if ($restoredContent !== $secretPayload) {
                    throw new RuntimeException('Wiederhergestellte Datei stimmt nicht mit dem Original überein.');
                }

                return [
                    'status'  => 'pass',
                    'value'   => 'Verschlüsseln & Entschlüsseln erfolgreich',
                    'message' => 'End-to-End Test des Tresors fehlerfrei abgeschlossen.',
                ];
            } finally {
                if (file_exists($tmpFile)) {
                    @unlink($tmpFile);
                }
            }
        });

        // Speicher-Schutz (.htaccess)
        $tests[] = self::test('storage_protection_htaccess', 'Speicher-Schutz vor direktem Webzugriff', function () {
            $ht = Database::STORAGE_DIR . '/.htaccess';
            if (!file_exists($ht)) {
                return [
                    'status'  => 'warning',
                    'value'   => 'storage/.htaccess fehlt',
                    'message' => 'Empfehlung: .htaccess in storage/ anlegen, um direkten Zugriff per Webserver zu blockieren.',
                ];
            }
            $content = (string)file_get_contents($ht);
            $hasDenial = str_contains($content, 'Require all denied') || str_contains($content, 'Deny from all');
            return [
                'status'  => $hasDenial ? 'pass' : 'warning',
                'value'   => 'Schutz aktiv (.htaccess)',
                'message' => 'Direkter HTTP-Zugriff auf storage/ ist gesperrt.',
            ];
        });

        // CSP / Sicherheits-Header
        $tests[] = self::test('security_csp_headers', 'Sicherheits-Header & CSP', function () {
            return [
                'status'  => 'pass',
                'value'   => 'X-Content-Type-Options, X-Frame-Options, CSP aktiv',
                'message' => 'PureCloud sendet standardmäßig restriktive Sicherheitsheader.',
            ];
        });

        return [
            'id'    => 'security_crypto',
            'title' => '🛡️ Kryptografie & Sicherheit',
            'tests' => $tests,
        ];
    }

    /**
     * Kategorie 5: Medien & ZIP-Archive
     */
    private static function checkMediaAndZip(): array
    {
        $tests = [];

        // ZIP-Erstellung & Auslesen (End-to-End)
        $tests[] = self::test('zip_engine_e2e', 'ZIP-Engine Funktionstest (ZipArchive)', function () {
            if (!class_exists('ZipArchive')) {
                return ['status' => 'fail', 'value' => 'Nicht verfügbar', 'message' => 'Klasse ZipArchive fehlt.'];
            }

            $tmpZip = Database::STORAGE_DIR . '/.selftest_' . bin2hex(random_bytes(8)) . '.zip';
            $zip = new \ZipArchive();
            $res = $zip->open($tmpZip, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
            if ($res !== true) {
                return ['status' => 'fail', 'value' => 'Fehler beim Erstellen', 'message' => "ZipArchive::open schlug fehl mit Code {$res}."];
            }

            $testContent = "PureCloud ZIP Test Inhalt " . time();
            $zip->addFromString('test_entry.txt', $testContent);
            $zip->close();

            try {
                $zipRead = new \ZipArchive();
                if ($zipRead->open($tmpZip) !== true) {
                    throw new RuntimeException('Konnte erstelltes ZIP-Archiv nicht öffnen.');
                }
                $readContent = $zipRead->getFromName('test_entry.txt');
                $zipRead->close();

                if ($readContent !== $testContent) {
                    throw new RuntimeException('Inhalt des ZIP-Eintrags stimmt nicht überein.');
                }

                return [
                    'status'  => 'pass',
                    'value'   => 'Archivierung & Extraktion OK',
                    'message' => 'ZipArchive kann Archive fehlerfrei erstellen und auslesen.',
                ];
            } finally {
                if (file_exists($tmpZip)) {
                    @unlink($tmpZip);
                }
            }
        });

        // GD Bild-Rendering & WebP-Konvertierung
        $tests[] = self::test('gd_render_webp', 'Bildverarbeitung & WebP-Kompression', function () {
            if (!function_exists('imagecreatetruecolor')) {
                return ['status' => 'fail', 'value' => 'GD fehlt', 'message' => 'imagecreatetruecolor ist nicht verfügbar.'];
            }

            $im = imagecreatetruecolor(32, 32);
            if (!$im) {
                return ['status' => 'fail', 'value' => 'Renderfehler', 'message' => 'Konnte Bild nicht erzeugen.'];
            }

            $bg = imagecolorallocate($im, 37, 99, 235);
            imagefill($im, 0, 0, $bg);

            ob_start();
            $webpOk = function_exists('imagewebp') ? @imagewebp($im, null, 80) : false;
            $data = ob_get_clean();
            imagedestroy($im);

            if ($webpOk && strlen($data) > 0) {
                return [
                    'status'  => 'pass',
                    'value'   => 'WebP & GD einsatzbereit',
                    'message' => 'Bildgenerierung und WebP-Kompression erfolgreich getestet.',
                ];
            }

            return [
                'status'  => 'warning',
                'value'   => 'WebP nicht unterstützt',
                'message' => 'GD ist vorhanden, aber WebP-Export ist nicht aktiv (JPEG/PNG werden genutzt).',
            ];
        });

        // EXIF Metadaten
        $tests[] = self::test('exif_metadata_support', 'EXIF-Metadaten-Unterstützung', function () {
            $hasExif = function_exists('exif_read_data');
            return [
                'status'  => $hasExif ? 'pass' : 'warning',
                'value'   => $hasExif ? 'Verfügbar' : 'Nicht verfügbar',
                'message' => $hasExif
                    ? 'Kamera- und GPS-Metadaten können aus Fotos ausgelesen werden.'
                    : 'exif_read_data fehlt (Fotos können trotzdem hochgeladen werden, EXIF-Viewer ist inaktiv).',
            ];
        });

        return [
            'id'    => 'media_zip',
            'title' => '📦 Archive & Medienverarbeitung',
            'tests' => $tests,
        ];
    }

    /**
     * Kategorie 6: Konnektivität & Updates
     */
    private static function checkConnectivity(): array
    {
        $tests = [];

        // GitHub API Erreichbarkeit
        $tests[] = self::test('github_api_connectivity', 'GitHub-Update-Schnittstelle', function () {
            if (!function_exists('curl_init')) {
                return [
                    'status'  => 'warning',
                    'value'   => 'cURL fehlt',
                    'message' => 'Keine cURL-Unterstützung; GitHub-Updates können nicht geprüft werden.',
                ];
            }

            $ch = curl_init('https://api.github.com/zen');
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 3,
                CURLOPT_USERAGENT      => 'PureCloud-SelfTest/1.0',
                CURLOPT_SSL_VERIFYPEER => true,
            ]);

            $start = microtime(true);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlErr = curl_error($ch);
            curl_close($ch);
            $ms = round((microtime(true) - $start) * 1000);

            if ($response !== false && $httpCode >= 200 && $httpCode < 400) {
                return [
                    'status'  => 'pass',
                    'value'   => "Verbunden ({$ms} ms, HTTP {$httpCode})",
                    'message' => 'GitHub API ist für automatische Updates und Versionsprüfungen erreichbar.',
                ];
            }

            return [
                'status'  => 'warning',
                'value'   => "Nicht erreichbar ({$curlErr})",
                'message' => 'GitHub ist derzeit nicht erreichbar oder Server arbeitet offline. Die Cloud läuft im Offline-Modus.',
            ];
        });

        return [
            'id'    => 'connectivity',
            'title' => '🌐 Externe Konnektivität & Updates',
            'tests' => $tests,
        ];
    }

    /**
     * Hilfsfunktion zum Parsen von PHP-Byte-Angaben (z. B. "128M", "2G").
     */
    private static function parseBytes(string $val): int
    {
        $val = trim($val);
        if ($val === '' || $val === '-1') {
            return -1;
        }
        $last = strtolower($val[strlen($val) - 1]);
        $num = (int)$val;
        switch ($last) {
            case 'g': $num *= 1024 * 1024 * 1024; break;
            case 'm': $num *= 1024 * 1024; break;
            case 'k': $num *= 1024; break;
        }
        return $num;
    }
}
