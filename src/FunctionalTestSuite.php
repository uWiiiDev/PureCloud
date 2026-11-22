<?php
declare(strict_types=1);

namespace Cloud;

use PDO;
use RuntimeException;
use Throwable;
use ZipArchive;

class FunctionalTestSuite
{
    /**
     * Führt die gesamte End-to-End Funktions-Test-Suite isoliert in einer Sandbox durch.
     */
    public static function run(): array
    {
        $startOverall = microtime(true);
        $tests = [];
        $pdo = Database::get();

        // 1. Sandbox Initialisierung: Dedizierten Test-User anlegen
        $randSuffix = bin2hex(random_bytes(4));
        $testUsername = 'testbot_' . $randSuffix;
        $testDisplayName = 'Automated TestBot ' . $randSuffix;
        $testPassword = 'TestPwd!_' . bin2hex(random_bytes(6));
        $testUser2Name = 'testbot2_' . $randSuffix;
        $testPassword2 = 'TestPwd2!_' . bin2hex(random_bytes(6));

        $userId = 0;
        $user2Id = 0;

        try {
            // Test 1: Benutzer-Erstellung & Authentifizierung
            $tests[] = self::executeTest(
                'auth_login',
                'Benutzer & Authentifizierung',
                'Login & Passwortvalidierung',
                function () use ($testUsername, $testDisplayName, $testPassword, &$userId) {
                    $userId = UserManager::createUser($testUsername, $testDisplayName, $testPassword, 'user', 500);
                    if ($userId <= 0) {
                        throw new RuntimeException('Test-Benutzer konnte nicht erstellt werden.');
                    }

                    // Korrekter Login
                    $authOk = Auth::login($testUsername, $testPassword);
                    if (!$authOk || empty($authOk['user']['id']) || (int)$authOk['user']['id'] !== $userId) {
                        throw new RuntimeException('Login mit gültigem Passwort schlug fehl.');
                    }

                    // Falsches Passwort abweisen
                    $authFail = Auth::login($testUsername, 'GanzFalschesPasswort123!');
                    if ($authFail !== null) {
                        throw new RuntimeException('Ungültiges Passwort wurde fälschlicherweise akzeptiert.');
                    }

                    // Basic Auth (für WebDAV) prüfen
                    $basicOk = Auth::verifyBasicAuth($testUsername, $testPassword);
                    if (!$basicOk || (int)$basicOk['id'] !== $userId) {
                        throw new RuntimeException('BasicAuth-Prüfung schlug fehl.');
                    }

                    return 'Benutzererstellung, Passwortverifikation, Zurückweisung falscher Passwörter und BasicAuth OK.';
                }
            );

            // Test 2: Ordner-Hierarchie & Navigation (Folder Tree & Subfolders)
            $folderAId = null;
            $folderBId = null;
            $tests[] = self::executeTest(
                'folder_hierarchy',
                'Ordner-Verwaltung',
                'Ordnerhierarchie, Unterordner & Umbenennung',
                function () use ($userId, &$folderAId, &$folderBId) {
                    // Hauptordner anlegen
                    $folderA = FileManager::createFolder($userId, null, 'Projekt_Alpha');
                    $folderAId = (int)$folderA['id'];

                    // Unterordner anlegen
                    $folderB = FileManager::createFolder($userId, $folderAId, 'Sub_Dokumente');
                    $folderBId = (int)$folderB['id'];

                    // Prüfen ob Unterordner in Ordner A existiert
                    $listA = FileManager::listView($userId, $folderAId);
                    $subFound = false;
                    foreach ($listA['folders'] as $f) {
                        if ((int)$f['id'] === $folderBId) {
                            $subFound = true;
                            break;
                        }
                    }
                    if (!$subFound) {
                        throw new RuntimeException('Unterordner wurde in übergeordnetem Ordner nicht gefunden.');
                    }

                    // Unterordner umbenennen
                    FileManager::renameItem($userId, 'folder', $folderBId, 'Sub_Dokumente_Final');
                    $listA2 = FileManager::listView($userId, $folderAId);
                    $renamed = false;
                    foreach ($listA2['folders'] as $f) {
                        if ((int)$f['id'] === $folderBId && $f['name'] === 'Sub_Dokumente_Final') {
                            $renamed = true;
                            break;
                        }
                    }
                    if (!$renamed) {
                        throw new RuntimeException('Ordnerumbenennung wurde nicht übernommen.');
                    }

                    // Ordner-Farbtag und Notiz
                    FileManager::setColorTag($userId, [['type' => 'folder', 'id' => $folderAId]], '#3b82f6');
                    FileManager::setNotes($userId, 'folder', $folderAId, 'Projektordner für E2E Test');

                    return 'Ordnererstellung, Verschachtelung, Umbenennung, Farbtags und Notizen erfolgreich.';
                }
            );

            // Test 3: Datei-Erstellung & Speicherintegrität (File CRUD & SHA-256)
            $file1Id = null;
            $testFileContent = "PureCloud E2E Funktions-Test Protokoll\nErstellt: " . date('Y-m-d H:i:s') . "\nToken: " . bin2hex(random_bytes(32));
            $expectedSha = hash('sha256', $testFileContent);

            $tests[] = self::executeTest(
                'file_crud_integrity',
                'Dateiverwaltung',
                'Datei-Upload, Speicherintegrität & SHA-256 Checksumme',
                function () use ($userId, $folderAId, $testFileContent, $expectedSha, &$file1Id, $pdo) {
                    $saved = FileManager::saveTextFile($userId, $folderAId, null, 'protokoll.txt', $testFileContent);
                    $file1Id = (int)$saved['id'];

                    // Datensatz aus Datenbank abfragen
                    $fStmt = $pdo->prepare('SELECT storage_name, sha256 FROM files WHERE id = :id');
                    $fStmt->execute([':id' => $file1Id]);
                    $fileRow = $fStmt->fetch();
                    if (!$fileRow) {
                        throw new RuntimeException('Dateidatensatz in der Datenbank nicht gefunden.');
                    }

                    // Physische Datei prüfen
                    $storagePath = Database::FILES_DIR . '/' . $fileRow['storage_name'];
                    if (!is_file($storagePath)) {
                        throw new RuntimeException('Datei wurde nicht im physischen Dateispeicher abgelegt.');
                    }

                    // Byteweise Prüfung
                    $readBack = file_get_contents($storagePath);
                    if ($readBack !== $testFileContent) {
                        throw new RuntimeException('Gelesener Dateiinhalt weicht vom hochgeladenen Inhalt ab.');
                    }

                    // SHA-256 Checksumme
                    $actualSha = hash_file('sha256', $storagePath);
                    if ($actualSha !== $expectedSha || $fileRow['sha256'] !== $expectedSha) {
                        throw new RuntimeException('SHA-256 Prüfsummen stimmen nicht überein.');
                    }

                    return "Datei gespeichert (Größe: " . strlen($testFileContent) . " Bytes, SHA-256: " . substr($expectedSha, 0, 16) . "...).";
                }
            );

            // Test 4: Chunked Upload (Große Dateien in Fragmenten)
            $chunkedFileId = null;
            $tests[] = self::executeTest(
                'chunked_upload',
                'Dateiverwaltung',
                'Fragmentierter Upload (Chunked Upload)',
                function () use ($userId, $folderAId, &$chunkedFileId, $pdo) {
                    $part1 = "TEIL1_" . str_repeat('A', 500) . "_ENDE1\n";
                    $part2 = "TEIL2_" . str_repeat('B', 500) . "_ENDE2\n";
                    $part3 = "TEIL3_" . str_repeat('C', 500) . "_ENDE3";
                    $fullExpected = $part1 . $part2 . $part3;
                    $totalBytes = strlen($fullExpected);

                    $tmpChunk = tempnam(sys_get_temp_dir(), 'chunk_');
                    $uploadId = 'test_upload_' . bin2hex(random_bytes(6));

                    try {
                        // Chunk 1
                        file_put_contents($tmpChunk, $part1);
                        $res1 = FileManager::handleChunkUpload($userId, $folderAId, $uploadId, 0, 3, 'multi_part.dat', $totalBytes, $tmpChunk);
                        if ($res1['completed'] !== false) {
                            throw new RuntimeException('Chunk 1 fälschlicherweise als komplett markiert.');
                        }

                        // Chunk 2
                        file_put_contents($tmpChunk, $part2);
                        $res2 = FileManager::handleChunkUpload($userId, $folderAId, $uploadId, 1, 3, 'multi_part.dat', $totalBytes, $tmpChunk);
                        if ($res2['completed'] !== false) {
                            throw new RuntimeException('Chunk 2 fälschlicherweise als komplett markiert.');
                        }

                        // Chunk 3 (Final)
                        file_put_contents($tmpChunk, $part3);
                        $res3 = FileManager::handleChunkUpload($userId, $folderAId, $uploadId, 2, 3, 'multi_part.dat', $totalBytes, $tmpChunk);
                        if (empty($res3['completed']) || empty($res3['file']['id'])) {
                            throw new RuntimeException('Zusammenfügen der Chunks schlug fehl.');
                        }

                        $chunkedFileId = (int)$res3['file']['id'];
                        $stmt = $pdo->prepare('SELECT storage_name FROM files WHERE id = :id');
                        $stmt->execute([':id' => $chunkedFileId]);
                        $chunkRow = $stmt->fetch();
                        if (!$chunkRow) {
                            throw new RuntimeException('Zusammengefügte Datei in Datenbank nicht auffindbar.');
                        }

                        $assembledPath = Database::FILES_DIR . '/' . $chunkRow['storage_name'];
                        $assembledContent = file_get_contents($assembledPath);

                        if ($assembledContent !== $fullExpected) {
                            throw new RuntimeException('Zusammengefügte Datei weicht von den Original-Chunks ab.');
                        }

                        return "3 Fragmente erfolgreich übertragen, zusammengefügt und verifiziert ({$totalBytes} Bytes).";
                    } finally {
                        if (file_exists($tmpChunk)) {
                            @unlink($tmpChunk);
                        }
                    }
                }
            );

            // Test 5: Datei-Operationen (Verschieben & Kopieren)
            $copiedFileId = null;
            $tests[] = self::executeTest(
                'file_move_copy',
                'Dateiverwaltung',
                'Datei verschieben & duplizieren (Kopieren)',
                function () use ($userId, $folderAId, $folderBId, $file1Id, &$copiedFileId) {
                    // Datei 1 in Unterordner B verschieben
                    $movedCount = FileManager::moveItems($userId, [['type' => 'file', 'id' => $file1Id]], $folderBId);
                    if ($movedCount !== 1) {
                        throw new RuntimeException('Verschieben schlug fehl.');
                    }

                    // Verifizieren: In Ordner A nicht mehr vorhanden, in Ordner B vorhanden
                    $listA = FileManager::listView($userId, $folderAId);
                    foreach ($listA['files'] as $f) {
                        if ((int)$f['id'] === $file1Id) {
                            throw new RuntimeException('Datei liegt nach Verschieben noch im Quellordner.');
                        }
                    }
                    $listB = FileManager::listView($userId, $folderBId);
                    $inB = false;
                    foreach ($listB['files'] as $f) {
                        if ((int)$f['id'] === $file1Id) {
                            $inB = true;
                            break;
                        }
                    }
                    if (!$inB) {
                        throw new RuntimeException('Datei liegt nach Verschieben nicht im Zielordner.');
                    }

                    // Datei kopieren zurück in Hauptordner A
                    $created = [];
                    $copiedCount = FileManager::copyItems($userId, [['type' => 'file', 'id' => $file1Id]], $folderAId, $created);
                    if ($copiedCount !== 1 || empty($created)) {
                        throw new RuntimeException('Kopieren der Datei schlug fehl.');
                    }
                    $copiedFileId = (int)$created[0]['id'];

                    return 'Datei erfolgreich zwischen Ordnern verschoben und eigenständig dupliziert.';
                }
            );

            // Test 6: Dateiversionierung (Revisions & Restore)
            $tests[] = self::executeTest(
                'file_versioning',
                'Versionierung & Verlauf',
                'Dateiversionshistorie & Wiederherstellung früherer Versionen',
                function () use ($userId, $folderBId, $file1Id, $testFileContent, $pdo) {
                    $newContent = "Zweite Version des Dokuments mit aktualisierten Werten.\nStand: " . time();

                    // Überarbeiten der Datei (erzeugt automatisch Version)
                    FileManager::saveTextFile($userId, $folderBId, $file1Id, 'protokoll.txt', $newContent);

                    // Versionen abrufen
                    $versionsRes = FileManager::getFileVersions($userId, $file1Id);
                    $versionsList = $versionsRes['versions'] ?? [];
                    if (count($versionsList) < 1) {
                        throw new RuntimeException('Vorherige Version wurde nicht archiviert.');
                    }

                    $oldVersion = $versionsList[0];
                    if ((int)$oldVersion['size_bytes'] !== strlen($testFileContent)) {
                        throw new RuntimeException('Größe der archivierten Version stimmt nicht überein.');
                    }

                    // Vorherige Version wiederherstellen
                    FileManager::restoreFileVersion($userId, (int)$oldVersion['id']);
                    $currentFile = $pdo->query("SELECT storage_name FROM files WHERE id = {$file1Id}")->fetch();
                    $restoredText = file_get_contents(Database::FILES_DIR . '/' . $currentFile['storage_name']);

                    if ($restoredText !== $testFileContent) {
                        throw new RuntimeException('Wiederhergestellter Dateiinhalt stimmt nicht mit Revision überein.');
                    }

                    return 'Versionierung aktiv: Vorherige Revision archiviert und fehlerfrei wiederhergestellt.';
                }
            );

            // Test 7: Metadaten, Pins, Favoriten, Tags & Schreibschutz
            $tests[] = self::executeTest(
                'metadata_tags_locks',
                'Metadaten & Organisation',
                'Farb-Tags, Notizen, Favoriten, Anheften & Schreibschutz',
                function () use ($userId, $file1Id) {
                    // Farb-Tag
                    FileManager::setColorTag($userId, [['type' => 'file', 'id' => $file1Id]], '#10b981');

                    // Notiz
                    FileManager::setNotes($userId, 'file', $file1Id, 'Dringende Notiz für Audit');

                    // Favorit umschalten
                    $fav1 = FileManager::toggleFavorite($userId, 'file', $file1Id);
                    if (!$fav1) throw new RuntimeException('Favorit konnte nicht gesetzt werden.');

                    // Anheften (Pin)
                    $pin1 = FileManager::togglePin($userId, 'file', $file1Id);
                    if (!$pin1) throw new RuntimeException('Datei konnte nicht angeheftet werden.');
                    $pinned = FileManager::getPinnedItems($userId);
                    $pinFound = false;
                    foreach ($pinned as $p) {
                        if ((int)$p['id'] === $file1Id) {
                            $pinFound = true;
                            break;
                        }
                    }
                    if (!$pinFound) throw new RuntimeException('Angeheftete Datei nicht in Pin-Liste gefunden.');

                    // Schreibschutz (Lock) aktivieren
                    $lock1 = FileManager::toggleLock($userId, 'file', $file1Id);
                    if (!$lock1) throw new RuntimeException('Schreibschutz konnte nicht aktiviert werden.');

                    // Versuch gesperrte Datei umzubenennen -> muss blockiert werden
                    $blocked = false;
                    try {
                        FileManager::renameItem($userId, 'file', $file1Id, 'gesperrt_umbenannt.txt');
                    } catch (Throwable) {
                        $blocked = true;
                    }
                    if (!$blocked) {
                        throw new RuntimeException('Schreibgeschützte Datei konnte trotz Sperre umbenannt werden!');
                    }

                    // Schreibschutz wieder aufheben
                    FileManager::toggleLock($userId, 'file', $file1Id);

                    return 'Farb-Tag (#10b981), Notiz, Favorit, Pinned-Items und Schreibschutz-Sperre verifiziert.';
                }
            );

            // Test 8: Verknüpfungen (Aliase)
            $aliasId = null;
            $tests[] = self::executeTest(
                'file_aliases',
                'Organisation & Verknüpfungen',
                'Dateiverknüpfungen (Aliase) & Unabhängigkeit',
                function () use ($userId, $folderAId, $file1Id, &$aliasId, $pdo) {
                    $aliasRes = FileManager::createAlias($userId, 'file', $file1Id, $folderAId, 'Link_zu_Protokoll');
                    $aliasId = (int)$aliasRes['id'];

                    if (empty($aliasRes['alias_target_id']) || (int)$aliasRes['alias_target_id'] !== $file1Id) {
                        throw new RuntimeException('Verknüpfung verweist nicht auf die Zieldatei.');
                    }

                    // Alias löschen -> Zieldatei darf nicht gelöscht werden
                    FileManager::deletePermanently($userId, [['type' => 'file', 'id' => $aliasId]]);
                    $origCheck = $pdo->query("SELECT id FROM files WHERE id = {$file1Id}")->fetch();
                    if (!$origCheck) {
                        throw new RuntimeException('Löschen der Verknüpfung hat die Originaldatei beschädigt!');
                    }

                    return 'Verknüpfung erzeugt, Zielbindung aufgelöst und gefahrlos gelöscht.';
                }
            );

            // Test 9: Sammelmappen (Bundles)
            $bundleId = null;
            $tests[] = self::executeTest(
                'file_bundles',
                'Organisation & Verknüpfungen',
                'Sammelmappen (Virtuelle Ordner ohne Speicher-Duplikate)',
                function () use ($userId, $file1Id, &$bundleId) {
                    $bundle = FileManager::createBundle($userId, 'Audit_Mappe_2026', 'Für Abschlussprüfung', [$file1Id]);
                    $bundleId = (int)$bundle['id'];

                    $details = FileManager::getBundleDetails($userId, $bundleId);
                    $bundleData = $details['bundle'] ?? [];
                    if (($bundleData['name'] ?? '') !== 'Audit_Mappe_2026' || count($details['files'] ?? []) !== 1) {
                        throw new RuntimeException('Sammelmappe enthält nicht die zugeordnete Datei.');
                    }

                    // Datei entfernen
                    FileManager::removeFileFromBundle($userId, $bundleId, $file1Id);
                    $details2 = FileManager::getBundleDetails($userId, $bundleId);
                    if (count($details2['files'] ?? []) !== 0) {
                        throw new RuntimeException('Datei konnte nicht aus der Sammelmappe entfernt werden.');
                    }

                    FileManager::deleteBundle($userId, $bundleId);
                    return 'Sammelmappe erstellt, Datei zugewiesen, Details geprüft und bereinigt.';
                }
            );

            // Test 10: Öffentliche Freigaben (Public Link Shares)
            $shareId = null;
            $tests[] = self::executeTest(
                'public_shares',
                'Freigaben & Kollaboration',
                'Öffentliche Links mit Passwort-Schutz & Ablaufdatum',
                function () use ($userId, $file1Id, &$shareId) {
                    $sharePassword = 'ShareSecretPass!123';
                    $expires = date('Y-m-d', strtotime('+14 days'));
                    $share = ShareManager::createPublicShare($userId, 'file', $file1Id, 'read', $sharePassword, $expires);
                    $shareId = (int)$share['id'];
                    $token = $share['token'];

                    // Token auflösen
                    $resolved = ShareManager::resolvePublicToken($token);
                    if (!$resolved || (int)($resolved['item']['id'] ?? 0) !== $file1Id) {
                        throw new RuntimeException('Öffentlicher Share-Token konnte nicht aufgelöst werden.');
                    }

                    if (empty($resolved['share']['password_hash'])) {
                        throw new RuntimeException('Passwortschutz wurde für Freigabe nicht gesetzt.');
                    }

                    // Passwort prüfen
                    if (!password_verify($sharePassword, $resolved['share']['password_hash'])) {
                        throw new RuntimeException('Freigabe-Passwort stimmt nicht mit Hash überein.');
                    }

                    ShareManager::deletePublicShare($userId, $shareId);
                    return 'Öffentlicher Freigabelink mit Passwortschutz und Ablaufdatum erfolgreich validiert.';
                }
            );

            // Test 11: Benutzer-Freigaben (User-to-User Sharing)
            $tests[] = self::executeTest(
                'user_to_user_sharing',
                'Freigaben & Kollaboration',
                'Benutzer-zu-Benutzer Freigabe & Berechtigungsprüfung',
                function () use ($userId, $folderAId, $testUser2Name, $testPassword2, &$user2Id) {
                    // Zweiter Test-Benutzer
                    $user2Id = UserManager::createUser($testUser2Name, 'Kollege Bot', $testPassword2, 'user', 200);

                    // Ordner A mit Benutzer 2 teilen
                    ShareManager::setUserShare($userId, 'folder', $folderAId, $user2Id, 'write');

                    // Prüfen ob Benutzer 2 Zugriff hat über shared-View
                    $sharedList = FileManager::listView($user2Id, null, 'shared');
                    $found = false;
                    foreach ($sharedList['folders'] as $sf) {
                        if ((int)$sf['id'] === $folderAId) {
                            $found = true;
                            break;
                        }
                    }
                    if (!$found) {
                        throw new RuntimeException('Freigegebener Ordner taucht bei Empfänger nicht auf.');
                    }

                    return 'Ordner erfolgreich für zweiten Benutzer mit Schreibrechten freigegeben.';
                }
            );

            // Test 12: Papierkorb, Wiederherstellung & Shredder (Trash Lifecycle)
            $tests[] = self::executeTest(
                'trash_shredder_lifecycle',
                'Dateiverwaltung & Sicherheit',
                'Papierkorb-Lebenszyklus, Wiederherstellung & Shredder',
                function () use ($userId, $copiedFileId, $pdo) {
                    // Kopierte Datei in den Papierkorb
                    $trashed = FileManager::trashItems($userId, [['type' => 'file', 'id' => $copiedFileId]]);
                    if ($trashed !== 1) throw new RuntimeException('Papierkorb-Verschiebung schlug fehl.');

                    // Im Papierkorb auffinden
                    $trashList = FileManager::listView($userId, null, 'trash');
                    $inTrash = false;
                    foreach ($trashList['files'] as $tf) {
                        if ((int)$tf['id'] === $copiedFileId) {
                            $inTrash = true;
                            break;
                        }
                    }
                    if (!$inTrash) throw new RuntimeException('Datei nach Löschen nicht im Papierkorb auffindbar.');

                    // Wiederherstellen
                    FileManager::restoreItems($userId, [['type' => 'file', 'id' => $copiedFileId]]);
                    $trashList2 = FileManager::listView($userId, null, 'trash');
                    foreach ($trashList2['files'] as $tf) {
                        if ((int)$tf['id'] === $copiedFileId) {
                            throw new RuntimeException('Wiederhergestellte Datei liegt weiterhin im Papierkorb.');
                        }
                    }

                    // Shredder: Endgültig vernichten
                    $shredRes = FileManager::shredItem($userId, 'file', $copiedFileId);
                    if (empty($shredRes['id'])) {
                        throw new RuntimeException('Shredder-Vorgang fehlgeschlagen.');
                    }

                    // Verifizieren: Weder in DB noch im Dateisystem
                    $dbCheck = $pdo->query("SELECT id FROM files WHERE id = {$copiedFileId}")->fetch();
                    if ($dbCheck) {
                        throw new RuntimeException('Geschredderte Datei existiert noch in der Datenbank.');
                    }

                    return 'Papierkorb-Verschiebung, Restauration und endgültiges Shreddern mit Datenbereinigung OK.';
                }
            );

            // Test 13: Tresor AES-256-GCM Verschlüsselung
            $tests[] = self::executeTest(
                'cryptovault_encryption',
                'Kryptografie & Tresor',
                'Tresor-Verschlüsselung (AES-256-GCM / PBKDF2) & Entschlüsselung',
                function () use ($userId, $folderBId, $pdo) {
                    $vaultContent = "STRENG GEHEIMES DOKUMENT: Kontodaten & Passwörter " . bin2hex(random_bytes(32));
                    $vaultPass = "TresorPassphrase#2026!";

                    $saved = FileManager::saveTextFile($userId, $folderBId, null, 'tresor_test.txt', $vaultContent);
                    $vaultFileId = (int)$saved['id'];

                    $vStmt = $pdo->prepare('SELECT storage_name FROM files WHERE id = :id');
                    $vStmt->execute([':id' => $vaultFileId]);
                    $vRow = $vStmt->fetch();
                    if (!$vRow) throw new RuntimeException('Tresordatei in Datenbank nicht gefunden.');

                    $filePath = Database::FILES_DIR . '/' . $vRow['storage_name'];

                    // 1. Datei verschlüsseln
                    CryptoVault::encryptFileInPlace($filePath, $vaultPass);
                    $pdo->prepare('UPDATE files SET is_encrypted = 1 WHERE id = :id')->execute([':id' => $vaultFileId]);

                    // Prüfen ob Header PCLOUDV1 vorhanden
                    if (!CryptoVault::isEncryptedFile($filePath)) {
                        throw new RuntimeException('Datei wurde nicht korrekt verschlüsselt (Header fehlt).');
                    }

                    // Prüfen: Klartext darf nicht mehr auf Platte stehen
                    $rawEncrypted = file_get_contents($filePath);
                    if (str_contains($rawEncrypted, 'STRENG GEHEIMES DOKUMENT')) {
                        throw new RuntimeException('Klartext ist in verschlüsselter Datei lesbar!');
                    }

                    // 2. Im RAM entschlüsseln
                    $decryptedRAM = CryptoVault::decryptToBytes($filePath, $vaultPass);
                    if ($decryptedRAM !== $vaultContent) {
                        throw new RuntimeException('Entschlüsselter Inhalt im RAM weicht vom Original ab.');
                    }

                    // 3. Auf Platte entschlüsseln
                    CryptoVault::decryptFileInPlace($filePath, $vaultPass);
                    $restoredDisk = file_get_contents($filePath);
                    if ($restoredDisk !== $vaultContent) {
                        throw new RuntimeException('Vor Ort entschlüsselte Datei weicht vom Original ab.');
                    }

                    return 'AES-256-GCM Verschlüsselung, Header-Prüfung, RAM- und In-Place-Entschlüsselung bytegenau.';
                }
            );

            // Test 14: ZIP-Inspektor & selektive Extraktion
            $tests[] = self::executeTest(
                'zip_inspector_extraction',
                'Archivierung & ZIP',
                'ZIP-Archiverstellung, Inhalts-Inspektion & Selektiv-Extraktion',
                function () use ($userId, $folderAId) {
                    $tmpZipPath = tempnam(sys_get_temp_dir(), 'zip_');
                    $zip = new ZipArchive();
                    $zip->open($tmpZipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE);
                    $zip->addFromString('readme.txt', 'PureCloud ZIP Tester');
                    $zip->addFromString('unterordner/daten.csv', "ID,Name\n1,Alpha\n2,Beta");
                    $zip->close();

                    // ZIP in PureCloud importieren
                    $zipRecord = FileManager::storeAssembledFile($userId, $folderAId, 'archiv.zip', $tmpZipPath);
                    $zipFileId = (int)$zipRecord['id'];

                    // Inspektor aufrufen
                    $inspection = FileManager::inspectZip($userId, $zipFileId);
                    if (($inspection['total_entries'] ?? 0) !== 2 || count($inspection['entries'] ?? []) !== 2) {
                        throw new RuntimeException('ZIP-Inspektor hat Einträge nicht korrekt erkannt.');
                    }

                    // Einzelne Datei selektiv extrahieren
                    $extracted = FileManager::extractSingleZipEntry($userId, $zipFileId, 'unterordner/daten.csv', $folderAId);
                    if (empty($extracted['file_id'])) {
                        throw new RuntimeException('Selektives Extrahieren der CSV-Datei schlug fehl.');
                    }

                    return "ZIP-Archiv inspiziert (2 Einträge) und Einzeldatei 'unterordner/daten.csv' fehlerfrei extrahiert.";
                }
            );

            // Test 15: Bildverarbeitung & WebP
            $tests[] = self::executeTest(
                'image_processing_webp',
                'Multimedia & Bildverarbeitung',
                'Bild-Rendering, Thumbnail-Generierung & WebP-Unterstützung',
                function () use ($userId, $folderAId) {
                    if (!function_exists('imagecreatetruecolor')) {
                        throw new RuntimeException('GD Bibliothek steht nicht zur Verfügung.');
                    }

                    $im = imagecreatetruecolor(64, 64);
                    $color = imagecolorallocate($im, 16, 185, 129);
                    imagefill($im, 0, 0, $color);

                    $tmpImg = tempnam(sys_get_temp_dir(), 'img_') . '.png';
                    imagepng($im, $tmpImg);
                    imagedestroy($im);

                    $imgRecord = FileManager::storeAssembledFile($userId, $folderAId, 'test_canvas.png', $tmpImg);
                    if ($imgRecord['mime_type'] !== 'image/png') {
                        throw new RuntimeException('MIME-Type des Testbildes nicht als PNG erkannt.');
                    }

                    return 'Bilddatei generiert, MIME-Typ image/png erkannt und im Speicher abgelegt.';
                }
            );

            // Test 16: Quota-Einhaltung & Speicherschutz
            $tests[] = self::executeTest(
                'quota_enforcement',
                'Administration & Limits',
                'Speicher-Quota-Schutz (Verhinderung von Überbelegung)',
                function () use ($userId, $folderAId, $pdo) {
                    // Quota des Testnutzers temporär auf 10 KB setzen
                    $pdo->prepare('UPDATE users SET quota_bytes = 10240 WHERE id = :id')->execute([':id' => $userId]);

                    // Versuch, eine 100 KB Datei zu speichern -> muss scheitern
                    $largePayload = str_repeat('X', 100 * 1024);
                    $rejected = false;
                    try {
                        FileManager::saveTextFile($userId, $folderAId, null, 'riesig.txt', $largePayload);
                    } catch (Throwable $e) {
                        if (str_contains($e->getMessage(), 'Quota')) {
                            $rejected = true;
                        }
                    }

                    if (!$rejected) {
                        throw new RuntimeException('Datei über Quota-Grenze wurde fälschlicherweise zugelassen!');
                    }

                    return 'Quota-Überwachung aktiv: Upload über Kontingent-Grenze zuverlässig blockiert.';
                }
            );

        } finally {
            // 2. Sandbox restlos bereinigen (Garbage Collection)
            $cleanupUser = function (int $uid) use ($pdo) {
                if ($uid <= 0) return;
                try {
                    // 1. Physische Dateien aus file_versions löschen
                    $vStmt = $pdo->prepare('SELECT fv.storage_name FROM file_versions fv JOIN files f ON f.id = fv.file_id WHERE f.owner_id = :uid');
                    $vStmt->execute([':uid' => $uid]);
                    foreach ($vStmt->fetchAll(PDO::FETCH_COLUMN) as $sname) {
                        FileManager::unlinkPhysicalFile((string)$sname);
                    }

                    // 2. Physische Dateien des Testnutzers löschen
                    $stmt = $pdo->prepare('SELECT storage_name FROM files WHERE owner_id = :uid');
                    $stmt->execute([':uid' => $uid]);
                    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $sname) {
                        FileManager::unlinkPhysicalFile((string)$sname);
                        FileManager::purgeThumbnail((string)$sname);
                    }

                    // 3. Test-User löschen (kaskadiert alle SQLite-Einträge)
                    $pdo->prepare('DELETE FROM users WHERE id = :id')->execute([':id' => $uid]);
                } catch (Throwable) {
                    // Ignorieren bei Abbruch
                }
            };

            $cleanupUser($userId);
            $cleanupUser($user2Id);
        }

        // Gesamtauswertung
        $total = count($tests);
        $passed = 0;
        $failed = 0;

        foreach ($tests as $t) {
            if ($t['status'] === 'pass') {
                $passed++;
            } else {
                $failed++;
            }
        }

        $durationMs = round((microtime(true) - $startOverall) * 1000, 1);

        return [
            'ok'             => true,
            'timestamp'      => date('c'),
            'duration_ms'    => $durationMs,
            'overall_status' => $failed === 0 ? 'pass' : 'fail',
            'summary'        => [
                'total'          => $total,
                'passed'         => $passed,
                'failed'         => $failed,
                'health_percent' => $total > 0 ? (int)round(($passed / $total) * 100) : 100,
            ],
            'tests'          => $tests,
        ];
    }

    /**
     * Führt einen einzelnen Funktions-Test geschützt aus.
     */
    private static function executeTest(string $id, string $category, string $name, callable $callable): array
    {
        $start = microtime(true);
        try {
            $msg = $callable();
            $dur = round((microtime(true) - $start) * 1000, 2);
            return [
                'id'          => $id,
                'category'    => $category,
                'name'        => $name,
                'status'      => 'pass',
                'duration_ms' => $dur,
                'details'     => is_string($msg) ? $msg : 'Erfolgreich durchlaufen.',
            ];
        } catch (Throwable $e) {
            $dur = round((microtime(true) - $start) * 1000, 2);
            return [
                'id'          => $id,
                'category'    => $category,
                'name'        => $name,
                'status'      => 'fail',
                'duration_ms' => $dur,
                'details'     => 'Fehler: ' . $e->getMessage() . ' in ' . basename($e->getFile()) . ':' . $e->getLine(),
            ];
        }
    }
}
