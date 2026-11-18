<?php
declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

use Cloud\Auth;
use Cloud\CryptoVault;
use Cloud\Database;
use Cloud\FileManager;
use Cloud\ShareManager;

Auth::startSession();
Auth::sendSecurityHeaders();

$settings = Database::getSettings();
$appName  = htmlspecialchars($settings['app_name'] ?? 'PureCloud', ENT_QUOTES, 'UTF-8');
$token    = trim((string)($_GET['t'] ?? $_POST['t'] ?? ''));

$resolved = ShareManager::resolvePublicToken($token);
if (!$resolved) {
    http_response_code(404);
    ?>
    <!DOCTYPE html>
    <html lang="de">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Freigabe nicht verfügbar – <?= $appName ?></title>
        <link rel="stylesheet" href="assets/css/app.css">
    </head>
    <body class="auth-body">
        <div class="auth-card">
            <div class="auth-logo">☁️</div>
            <h1>Link ungültig oder abgelaufen</h1>
            <p class="muted">Diese Freigabe existiert nicht mehr, ist abgelaufen oder hat das maximale Download-Limit erreicht.</p>
        </div>
    </body>
    </html>
    <?php
    exit;
}

$share   = $resolved['share'];
$rootItem = $resolved['item'];
$shareId = (int)$share['id'];
$ownerId = (int)$share['owner_id'];
$mode    = (string)$share['mode']; // 'download' | 'upload' | 'readwrite'

// Password verification
$sessionKey = 'pub_share_ok_' . $share['token'];
$pwError    = '';

if ($share['password_hash'] !== null && empty($_SESSION[$sessionKey])) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && isset($_POST['share_password'])) {
        try {
            Auth::assertNotRateLimited('share_pw');
            if (password_verify((string)$_POST['share_password'], (string)$share['password_hash'])) {
                Auth::clearRateLimit('share_pw');
                $_SESSION[$sessionKey] = true;
            } else {
                Auth::recordFailedAttempt('share_pw', 8, 900, 900);
                $pwError = 'Das eingegebene Passwort ist falsch.';
            }
        } catch (Throwable $e) {
            $pwError = $e->getMessage();
        }
    }
    if (empty($_SESSION[$sessionKey])) {
        ?>
        <!DOCTYPE html>
        <html lang="de">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Geschützte Freigabe – <?= $appName ?></title>
            <link rel="stylesheet" href="assets/css/app.css">
        </head>
        <body class="auth-body">
            <div class="auth-card">
                <div class="auth-logo">🔒</div>
                <h1>Passwortgeschützte Freigabe</h1>
                <p class="muted">Bitte geben Sie das Passwort ein, um auf <strong><?= htmlspecialchars($rootItem['name']) ?></strong> zuzugreifen.</p>
                <?php if ($pwError !== ''): ?>
                    <div class="alert alert-error"><?= htmlspecialchars($pwError) ?></div>
                <?php endif; ?>
                <form method="post" action="share.php?t=<?= urlencode($token) ?>">
                    <div class="form-group">
                        <input type="password" name="share_password" class="input" placeholder="Passwort eingeben…" required autofocus>
                    </div>
                    <button type="submit" class="btn btn-primary btn-block">Freigabe öffnen</button>
                </form>
            </div>
        </body>
        </html>
        <?php
        exit;
    }
}

$pdo = Database::get();

// Helper: verify that a folder is either the shared root folder or a descendant of it
function isSubfolderOfSharedRoot(PDO $pdo, int $candidateId, int $rootFolderId): bool
{
    $curr = $candidateId;
    $depth = 0;
    while ($curr > 0 && $depth < 100) {
        if ($curr === $rootFolderId) {
            return true;
        }
        $stmt = $pdo->prepare('SELECT parent_id FROM folders WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $curr]);
        $parent = $stmt->fetchColumn();
        $curr = ($parent !== false && $parent !== null) ? (int)$parent : 0;
        $depth++;
    }
    return false;
}

// 1. Single File Share Download
if ($share['item_type'] === 'file' && !empty($_GET['dl'])) {
    $pdo->prepare('UPDATE public_shares SET download_count = download_count + 1 WHERE id = :id')->execute([':id' => $shareId]);
    $path = Database::FILES_DIR . '/' . basename($rootItem['storage_name']);
    $inline = !empty($_GET['inline']);
    $vaultPw = (string)($_POST['vault_password'] ?? '');
    if ((int)$rootItem['is_encrypted'] === 1 && $vaultPw !== '') {
        try {
            Auth::assertNotRateLimited('vault_share');
            $plain = CryptoVault::decryptToBytes($path, $vaultPw);
            Auth::clearRateLimit('vault_share');
            $safeName = str_replace(['"', "\r", "\n"], '', $rootItem['name']);
            header('Content-Type: ' . $rootItem['mime_type']);
            header('Content-Length: ' . strlen($plain));
            header('Content-Disposition: attachment; filename="' . $safeName . '"');
            header('X-Content-Type-Options: nosniff');
            header("Content-Security-Policy: default-src 'none'; sandbox");
            echo $plain;
            exit;
        } catch (Throwable $e) {
            Auth::recordFailedAttempt('vault_share', 8, 900, 900);
            $pwError = $e->getMessage();
        }
    } else {
        FileManager::streamPhysicalFile($path, $rootItem['name'], $rootItem['mime_type'], $inline);
    }
}

// 2. Folder Share actions (Download file, Download ZIP, or Guest Upload)
$activeFolderId = (int)$rootItem['id'];
if ($share['item_type'] === 'folder' && !empty($_GET['sub'])) {
    $subId = (int)$_GET['sub'];
    if (isSubfolderOfSharedRoot($pdo, $subId, (int)$rootItem['id'])) {
        $activeFolderId = $subId;
    }
}

if ($share['item_type'] === 'folder' && in_array($mode, ['download', 'readwrite'], true)) {
    if (!empty($_GET['dl_file'])) {
        $fileId = (int)$_GET['dl_file'];
        $fStmt = $pdo->prepare('SELECT * FROM files WHERE id = :id AND owner_id = :uid AND deleted_at IS NULL LIMIT 1');
        $fStmt->execute([':id' => $fileId, ':uid' => $ownerId]);
        $fl = $fStmt->fetch();
        if ($fl && $fl['folder_id'] !== null && isSubfolderOfSharedRoot($pdo, (int)$fl['folder_id'], (int)$rootItem['id'])) {
            $pdo->prepare('UPDATE public_shares SET download_count = download_count + 1 WHERE id = :id')->execute([':id' => $shareId]);
            $path = Database::FILES_DIR . '/' . basename($fl['storage_name']);
            FileManager::streamPhysicalFile($path, $fl['name'], $fl['mime_type'], !empty($_GET['inline']));
        }
    }

    if (!empty($_GET['dl_zip'])) {
        $pdo->prepare('UPDATE public_shares SET download_count = download_count + 1 WHERE id = :id')->execute([':id' => $shareId]);
        $tmpZip = FileManager::buildMultiItemZip($ownerId, [['type' => 'folder', 'id' => $activeFolderId, 'name' => $rootItem['name']]]);
        register_shutdown_function(function () use ($tmpZip) {
            if (is_file($tmpZip)) {
                @unlink($tmpZip);
            }
        });
        FileManager::streamPhysicalFile($tmpZip, $rootItem['name'] . '.zip', 'application/zip', false);
    }
}

// Guest Upload in 'upload' or 'readwrite' folder mode
$uploadSuccess = '';
$uploadError   = '';
if ($share['item_type'] === 'folder' && in_array($mode, ['upload', 'readwrite'], true) && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && !empty($_FILES['guest_files'])) {
    try {
        $filesArr = $_FILES['guest_files'];
        $names    = is_array($filesArr['name']) ? $filesArr['name'] : [$filesArr['name']];
        $tmpNames = is_array($filesArr['tmp_name']) ? $filesArr['tmp_name'] : [$filesArr['tmp_name']];
        $errors   = is_array($filesArr['error']) ? $filesArr['error'] : [$filesArr['error']];
        $uploadedCount = 0;

        foreach ($names as $idx => $rawName) {
            if (($errors[$idx] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || empty($tmpNames[$idx])) {
                continue;
            }
            $cleanName = FileManager::sanitizeName((string)$rawName);
            if ($cleanName === '') {
                continue;
            }
            // Avoid overwriting existing files when in pure 'upload' (File-Drop) mode by adding timestamp if needed
            if ($mode === 'upload') {
                $chk = $pdo->prepare('SELECT id FROM files WHERE owner_id = :uid AND folder_id = :fid AND name = :n COLLATE NOCASE AND deleted_at IS NULL LIMIT 1');
                $chk->execute([':uid' => $ownerId, ':fid' => $activeFolderId, ':n' => $cleanName]);
                if ($chk->fetchColumn()) {
                    $ext  = pathinfo($cleanName, PATHINFO_EXTENSION);
                    $base = pathinfo($cleanName, PATHINFO_FILENAME);
                    $cleanName = $base . '_' . date('His') . ($ext !== '' ? '.' . $ext : '');
                }
            }
            $tmpCopy = Database::CHUNKS_DIR . '/guest_' . bin2hex(random_bytes(8)) . '.tmp';
            move_uploaded_file($tmpNames[$idx], $tmpCopy);
            FileManager::storeAssembledFile($ownerId, $activeFolderId, $cleanName, $tmpCopy);
            $uploadedCount++;
        }

        if ($uploadedCount > 0) {
            $uploadSuccess = $uploadedCount === 1
                ? '1 Datei wurde erfolgreich hochgeladen.'
                : "$uploadedCount Dateien wurden erfolgreich hochgeladen.";
        } else {
            $uploadError = 'Keine gültige Datei ausgewählt.';
        }
    } catch (Throwable $e) {
        $uploadError = $e->getMessage();
    }
}

function formatBytesShare(int $bytes): string
{
    if ($bytes <= 0) return '0 B';
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $i = (int)floor(log($bytes, 1024));
    return round($bytes / (1024 ** $i), $i > 1 ? 2 : 0) . ' ' . $units[$i];
}
?>
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= htmlspecialchars($rootItem['name']) ?> – <?= $appName ?></title>
    <link rel="stylesheet" href="assets/css/app.css">
</head>
<body class="share-page-body">
    <div class="share-container">
        <header class="share-header">
            <div class="brand">
                <span class="brand-icon">☁️</span>
                <div>
                    <strong><?= htmlspecialchars($rootItem['name']) ?></strong>
                    <div class="muted small">
                        <?= $appName ?> Freigabe
                        <?php if ($share['expires_at']): ?>
                            · Gültig bis <?= htmlspecialchars($share['expires_at']) ?>
                        <?php endif; ?>
                    </div>
                </div>
            </div>
            <?php if ($share['item_type'] === 'folder' && in_array($mode, ['download', 'readwrite'], true)): ?>
                <a class="btn btn-primary" href="share.php?t=<?= urlencode($token) ?>&sub=<?= $activeFolderId ?>&dl_zip=1">
                    📦 Als ZIP herunterladen
                </a>
            <?php endif; ?>
        </header>

        <?php if ($pwError !== '' || $uploadError !== ''): ?>
            <div class="alert alert-error"><?= htmlspecialchars($pwError ?: $uploadError) ?></div>
        <?php endif; ?>
        <?php if ($uploadSuccess !== ''): ?>
            <div class="alert alert-success"><?= htmlspecialchars($uploadSuccess) ?></div>
        <?php endif; ?>

        <?php if ($share['item_type'] === 'file'): ?>
            <?php
            $cat = FileManager::categorizeFile($rootItem['name'], $rootItem['mime_type']);
            $isEnc = (int)$rootItem['is_encrypted'] === 1;
            ?>
            <div class="share-file-box">
                <div class="share-file-icon"><?= $isEnc ? '🔒' : ($cat === 'image' ? '🖼️' : ($cat === 'pdf' ? '📕' : ($cat === 'zip' ? '📦' : '📄'))) ?></div>
                <h2><?= htmlspecialchars($rootItem['name']) ?></h2>
                <p class="muted"><?= formatBytesShare((int)$rootItem['size_bytes']) ?> · <?= htmlspecialchars($rootItem['mime_type']) ?></p>

                <?php if (!$isEnc && $cat === 'image'): ?>
                    <div class="share-preview-box">
                        <img src="share.php?t=<?= urlencode($token) ?>&dl=1&inline=1" alt="<?= htmlspecialchars($rootItem['name']) ?>">
                    </div>
                <?php elseif (!$isEnc && $cat === 'video'): ?>
                    <div class="share-preview-box">
                        <video controls preload="metadata" src="share.php?t=<?= urlencode($token) ?>&dl=1&inline=1"></video>
                    </div>
                <?php elseif (!$isEnc && $cat === 'audio'): ?>
                    <div class="share-preview-box">
                        <audio controls preload="metadata" src="share.php?t=<?= urlencode($token) ?>&dl=1&inline=1"></audio>
                    </div>
                <?php endif; ?>

                <?php if ($isEnc): ?>
                    <form method="post" action="share.php?t=<?= urlencode($token) ?>&dl=1" class="vault-share-form">
                        <p class="small muted">Diese Datei ist mit AES-256-GCM im Tresor verschlüsselt. Geben Sie das Tresor-Passwort ein, um sie entschlüsselt herunterzuladen:</p>
                        <div class="form-row">
                            <input type="password" name="vault_password" class="input" placeholder="Tresor-Passwort…">
                            <button type="submit" class="btn btn-primary">🔓 Entschlüsselt herunterladen</button>
                        </div>
                    </form>
                <?php else: ?>
                    <a class="btn btn-primary btn-lg" href="share.php?t=<?= urlencode($token) ?>&dl=1">
                        ⬇️ Datei herunterladen
                    </a>
                <?php endif; ?>
            </div>
        <?php else: ?>
            <?php if (in_array($mode, ['upload', 'readwrite'], true)): ?>
                <form method="post" enctype="multipart/form-data" class="share-dropzone">
                    <div class="dropzone-content">
                        <div style="font-size:2rem">📤</div>
                        <div>
                            <strong>Dateien hier ablegen oder auswählen</strong>
                            <div class="muted small">
                                <?= $mode === 'upload' ? 'Digitaler Briefkasten (File-Drop) – Hochgeladene Dateien sind nur für den Eigentümer sichtbar.' : 'Dateien in diesen freigegebenen Ordner hochladen' ?>
                            </div>
                        </div>
                        <input type="file" name="guest_files[]" multiple required class="input" style="max-width:320px">
                        <button type="submit" class="btn btn-primary">Hochladen</button>
                    </div>
                </form>
            <?php endif; ?>

            <?php if (in_array($mode, ['download', 'readwrite'], true)): ?>
                <?php
                if ($activeFolderId !== (int)$rootItem['id']) {
                    $pStmt = $pdo->prepare('SELECT parent_id, name FROM folders WHERE id = :id LIMIT 1');
                    $pStmt->execute([':id' => $activeFolderId]);
                    $currFolderRow = $pStmt->fetch();
                    $backId = ($currFolderRow && $currFolderRow['parent_id']) ? (int)$currFolderRow['parent_id'] : (int)$rootItem['id'];
                    echo '<div style="margin-bottom:0.75rem"><a class="btn btn-ghost" href="share.php?t=' . urlencode($token) . '&sub=' . $backId . '">← Zurück</a> <strong style="margin-left:0.5rem">' . htmlspecialchars($currFolderRow['name'] ?? '') . '</strong></div>';
                }

                $subStmt = $pdo->prepare('SELECT id, name, updated_at FROM folders WHERE parent_id = :pid AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC');
                $subStmt->execute([':pid' => $activeFolderId]);
                $subfolders = $subStmt->fetchAll();

                $flStmt = $pdo->prepare('SELECT id, name, size_bytes, mime_type, is_encrypted, updated_at FROM files WHERE folder_id = :fid AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC');
                $flStmt->execute([':fid' => $activeFolderId]);
                $files = $flStmt->fetchAll();
                ?>
                <div class="file-table-wrap">
                    <table class="file-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Größe</th>
                                <th>Geändert</th>
                                <th style="text-align:right">Aktion</th>
                            </tr>
                        </thead>
                        <tbody>
                            <?php if (empty($subfolders) && empty($files)): ?>
                                <tr>
                                    <td colspan="4" class="empty-cell">Dieser Ordner ist leer.</td>
                                </tr>
                            <?php endif; ?>
                            <?php foreach ($subfolders as $sf): ?>
                                <tr>
                                    <td>
                                        <a class="item-link" href="share.php?t=<?= urlencode($token) ?>&sub=<?= (int)$sf['id'] ?>">
                                            📁 <?= htmlspecialchars($sf['name']) ?>
                                        </a>
                                    </td>
                                    <td class="muted">—</td>
                                    <td class="muted"><?= htmlspecialchars($sf['updated_at']) ?></td>
                                    <td style="text-align:right">
                                        <a class="btn btn-sm btn-ghost" href="share.php?t=<?= urlencode($token) ?>&sub=<?= (int)$sf['id'] ?>">Öffnen</a>
                                    </td>
                                </tr>
                            <?php endforeach; ?>
                            <?php foreach ($files as $fl): ?>
                                <tr>
                                    <td>
                                        <?= (int)$fl['is_encrypted'] === 1 ? '🔒' : '📄' ?>
                                        <?= htmlspecialchars($fl['name']) ?>
                                    </td>
                                    <td class="muted"><?= formatBytesShare((int)$fl['size_bytes']) ?></td>
                                    <td class="muted"><?= htmlspecialchars($fl['updated_at']) ?></td>
                                    <td style="text-align:right">
                                        <a class="btn btn-sm btn-primary" href="share.php?t=<?= urlencode($token) ?>&sub=<?= $activeFolderId ?>&dl_file=<?= (int)$fl['id'] ?>">⬇️ Download</a>
                                    </td>
                                </tr>
                            <?php endforeach; ?>
                        </tbody>
                    </table>
                </div>
            <?php endif; ?>
        <?php endif; ?>
    </div>
</body>
</html>
