<?php
/**
 * Native WebDAV Endpoint (webdav.php)
 * Supports: OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK
 */
declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

use Cloud\Auth;
use Cloud\Database;
use Cloud\FileManager;

$settings = Database::getSettings();
if (($settings['enable_webdav'] ?? '1') !== '1') {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    exit('WebDAV ist deaktiviert.');
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

header('DAV: 1, 2');
header('MS-Author-Via: DAV');
header('Accept-Ranges: bytes');
header('X-Content-Type-Options: nosniff');

if ($method === 'OPTIONS') {
    header('Allow: OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, PROPPATCH, MOVE, COPY, LOCK, UNLOCK');
    http_response_code(200);
    exit;
}

// Parse HTTP Basic Auth
$authUser = $_SERVER['PHP_AUTH_USER'] ?? null;
$authPass = $_SERVER['PHP_AUTH_PW'] ?? null;

if ($authUser === null) {
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (stripos($authHeader, 'Basic ') === 0) {
        $decoded = base64_decode(substr($authHeader, 6), true);
        if ($decoded !== false && str_contains($decoded, ':')) {
            [$authUser, $authPass] = explode(':', $decoded, 2);
        }
    }
}

$scriptName = $_SERVER['SCRIPT_NAME'] ?? '/webdav.php';
$requestUri = parse_url($_SERVER['REQUEST_URI'] ?? '/webdav.php', PHP_URL_PATH) ?: '/webdav.php';
$rawRelPath = '';
if (!empty($_SERVER['PATH_INFO'])) {
    $rawRelPath = (string)$_SERVER['PATH_INFO'];
} elseif (str_starts_with($requestUri, $scriptName)) {
    $rawRelPath = substr($requestUri, strlen($scriptName));
}
$rawRelPath = trim(rawurldecode($rawRelPath), '/');

// Friendly HTML info page if opened directly in browser without WebDAV credentials
if ($method === 'GET' && $rawRelPath === '' && $authUser === null && str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'text/html')) {
    $proto   = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host    = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $baseUrl = $proto . '://' . $host . $scriptName . '/';
    $appName = htmlspecialchars($settings['app_name'] ?? 'PureCloud', ENT_QUOTES, 'UTF-8');
    header('Content-Type: text/html; charset=utf-8');
    ?>
    <!DOCTYPE html>
    <html lang="de">
    <head>
        <meta charset="utf-8">
        <title>WebDAV – <?= $appName ?></title>
        <link rel="stylesheet" href="assets/css/app.css">
    </head>
    <body class="auth-body">
        <div class="auth-card" style="max-width:520px;text-align:left">
            <h2>📡 WebDAV-Schnittstelle aktiv</h2>
            <p class="muted">Binden Sie Ihren <strong><?= $appName ?></strong>-Speicher direkt als Netzlaufwerk in Windows Explorer, macOS Finder, Linux oder auf dem Smartphone ein:</p>
            <div class="code-box"><?= htmlspecialchars($baseUrl) ?></div>
            <p class="small muted" style="margin-top:0.75rem">Melden Sie sich mit Ihrem normalen Benutzernamen und Passwort an.</p>
            <a class="btn btn-primary" href="index.php">← Zurück zur Cloud</a>
        </div>
    </body>
    </html>
    <?php
    exit;
}

if ($authUser === null || $authPass === null || trim($authUser) === '') {
    header('WWW-Authenticate: Basic realm="Cloud WebDAV"');
    http_response_code(401);
    exit('Authentifizierung erforderlich.');
}

$user = Auth::verifyBasicAuth((string)$authUser, (string)$authPass);
if (!$user) {
    header('WWW-Authenticate: Basic realm="Cloud WebDAV"');
    http_response_code(401);
    exit('Ungültige Zugangsdaten.');
}

$userId = (int)$user['id'];
$pdo    = Database::get();

/**
 * Resolves a slash-separated relative WebDAV path for $userId.
 * Returns:
 * - ['type' => 'root', 'id' => null]
 * - ['type' => 'folder', 'id' => int, 'row' => array]
 * - ['type' => 'file', 'id' => int, 'row' => array]
 * - null if not found
 */
function davResolvePath(PDO $pdo, int $userId, string $relPath): ?array
{
    $relPath = trim($relPath, '/');
    if ($relPath === '') {
        return ['type' => 'root', 'id' => null, 'name' => ''];
    }

    $parts = array_values(array_filter(explode('/', $relPath), fn($p) => $p !== '' && $p !== '.'));
    $count = count($parts);
    $parentId = null;

    for ($i = 0; $i < $count; $i++) {
        $seg = $parts[$i];
        $isLast = ($i === $count - 1);

        // Try matching folder first
        if ($parentId === null) {
            $fStmt = $pdo->prepare('SELECT * FROM folders WHERE owner_id = :uid AND parent_id IS NULL AND name = :name COLLATE NOCASE AND deleted_at IS NULL LIMIT 1');
            $fStmt->execute([':uid' => $userId, ':name' => $seg]);
        } else {
            $fStmt = $pdo->prepare('SELECT * FROM folders WHERE owner_id = :uid AND parent_id = :pid AND name = :name COLLATE NOCASE AND deleted_at IS NULL LIMIT 1');
            $fStmt->execute([':uid' => $userId, ':pid' => $parentId, ':name' => $seg]);
        }
        $folder = $fStmt->fetch();
        if ($folder) {
            if ($isLast) {
                return ['type' => 'folder', 'id' => (int)$folder['id'], 'row' => $folder];
            }
            $parentId = (int)$folder['id'];
            continue;
        }

        // If last segment, try matching file
        if ($isLast) {
            if ($parentId === null) {
                $flStmt = $pdo->prepare('SELECT * FROM files WHERE owner_id = :uid AND folder_id IS NULL AND name = :name COLLATE NOCASE AND deleted_at IS NULL LIMIT 1');
                $flStmt->execute([':uid' => $userId, ':name' => $seg]);
            } else {
                $flStmt = $pdo->prepare('SELECT * FROM files WHERE owner_id = :uid AND folder_id = :fid AND name = :name COLLATE NOCASE AND deleted_at IS NULL LIMIT 1');
                $flStmt->execute([':uid' => $userId, ':fid' => $parentId, ':name' => $seg]);
            }
            $file = $flStmt->fetch();
            if ($file) {
                return ['type' => 'file', 'id' => (int)$file['id'], 'row' => $file];
            }
        }

        return null;
    }

    return null;
}

function davEncodeHref(string $scriptName, string $relPath): string
{
    $base = rtrim($scriptName, '/');
    if ($relPath === '') {
        return $base . '/';
    }
    $segments = array_map('rawurlencode', explode('/', trim($relPath, '/')));
    return $base . '/' . implode('/', $segments);
}

function davXmlResponse(string $href, bool $isDir, string $displayName, int $size, string $updatedAt, string $mime = 'application/octet-stream'): string
{
    $mtime = gmdate('D, d M Y H:i:s', strtotime($updatedAt) ?: time()) . ' GMT';
    $etag  = '"' . md5($href . ':' . $size . ':' . $updatedAt) . '"';
    $hrefEsc = htmlspecialchars($href . ($isDir && !str_ends_with($href, '/') ? '/' : ''), ENT_XML1);
    $nameEsc = htmlspecialchars($displayName, ENT_XML1);

    $xml  = "<D:response>";
    $xml .= "<D:href>{$hrefEsc}</D:href>";
    $xml .= "<D:propstat><D:prop>";
    $xml .= "<D:displayname>{$nameEsc}</D:displayname>";
    $xml .= "<D:getlastmodified>{$mtime}</D:getlastmodified>";
    $xml .= "<D:getetag>{$etag}</D:getetag>";
    if ($isDir) {
        $xml .= "<D:resourcetype><D:collection/></D:resourcetype>";
    } else {
        $mimeEsc = htmlspecialchars($mime, ENT_XML1);
        $xml .= "<D:resourcetype/>";
        $xml .= "<D:getcontentlength>{$size}</D:getcontentlength>";
        $xml .= "<D:getcontenttype>{$mimeEsc}</D:getcontenttype>";
    }
    $xml .= "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>";
    $xml .= "</D:response>";
    return $xml;
}

switch ($method) {
    case 'PROPFIND':
        $resolved = davResolvePath($pdo, $userId, $rawRelPath);
        if (!$resolved) {
            http_response_code(404);
            exit;
        }

        $depth = strtolower((string)($_SERVER['HTTP_DEPTH'] ?? '1'));
        $responses = [];

        if ($resolved['type'] === 'file') {
            $fl = $resolved['row'];
            $responses[] = davXmlResponse(
                davEncodeHref($scriptName, $rawRelPath),
                false,
                $fl['name'],
                (int)$fl['size_bytes'],
                $fl['updated_at'],
                $fl['mime_type']
            );
        } else {
            $folderId = $resolved['id'];
            $folderName = $resolved['type'] === 'root' ? '' : $resolved['row']['name'];
            $updatedAt  = $resolved['type'] === 'root' ? gmdate('Y-m-d H:i:s') : $resolved['row']['updated_at'];

            $responses[] = davXmlResponse(
                davEncodeHref($scriptName, $rawRelPath),
                true,
                $folderName,
                0,
                $updatedAt
            );

            if ($depth !== '0') {
                if ($folderId === null) {
                    $fStmt = $pdo->prepare('SELECT * FROM folders WHERE owner_id = :uid AND parent_id IS NULL AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC');
                    $fStmt->execute([':uid' => $userId]);
                    $flStmt = $pdo->prepare('SELECT * FROM files WHERE owner_id = :uid AND folder_id IS NULL AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC');
                    $flStmt->execute([':uid' => $userId]);
                } else {
                    $fStmt = $pdo->prepare('SELECT * FROM folders WHERE owner_id = :uid AND parent_id = :pid AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC');
                    $fStmt->execute([':uid' => $userId, ':pid' => $folderId]);
                    $flStmt = $pdo->prepare('SELECT * FROM files WHERE owner_id = :uid AND folder_id = :fid AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC');
                    $flStmt->execute([':uid' => $userId, ':fid' => $folderId]);
                }

                foreach ($fStmt->fetchAll() as $sub) {
                    $childRel = ltrim($rawRelPath . '/' . $sub['name'], '/');
                    $responses[] = davXmlResponse(
                        davEncodeHref($scriptName, $childRel),
                        true,
                        $sub['name'],
                        0,
                        $sub['updated_at']
                    );
                }
                foreach ($flStmt->fetchAll() as $fl) {
                    $childRel = ltrim($rawRelPath . '/' . $fl['name'], '/');
                    $responses[] = davXmlResponse(
                        davEncodeHref($scriptName, $childRel),
                        false,
                        $fl['name'],
                        (int)$fl['size_bytes'],
                        $fl['updated_at'],
                        $fl['mime_type']
                    );
                }
            }
        }

        http_response_code(207);
        header('Content-Type: application/xml; charset=utf-8');
        echo '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' . implode('', $responses) . '</D:multistatus>';
        exit;

    case 'PROPPATCH':
        $href = htmlspecialchars(davEncodeHref($scriptName, $rawRelPath), ENT_XML1);
        http_response_code(207);
        header('Content-Type: application/xml; charset=utf-8');
        echo '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>' . $href . '</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
        exit;

    case 'GET':
    case 'HEAD':
        $resolved = davResolvePath($pdo, $userId, $rawRelPath);
        if (!$resolved || $resolved['type'] !== 'file') {
            http_response_code(404);
            exit;
        }
        $fl = $resolved['row'];
        $path = Database::FILES_DIR . '/' . basename($fl['storage_name']);
        FileManager::streamPhysicalFile($path, $fl['name'], $fl['mime_type'], true);

    case 'MKCOL':
        if ($rawRelPath === '') {
            http_response_code(405);
            exit;
        }
        if (davResolvePath($pdo, $userId, $rawRelPath) !== null) {
            http_response_code(405);
            exit;
        }
        $parentRel = dirname($rawRelPath);
        $parentId  = null;
        if ($parentRel !== '' && $parentRel !== '.') {
            $parentResolved = davResolvePath($pdo, $userId, $parentRel);
            if (!$parentResolved || !in_array($parentResolved['type'], ['root', 'folder'], true)) {
                http_response_code(409);
                exit;
            }
            $parentId = $parentResolved['id'];
        }
        $folderName = FileManager::sanitizeName(basename($rawRelPath));
        if ($folderName === '') {
            http_response_code(400);
            exit;
        }
        FileManager::createFolder($userId, $parentId, $folderName);
        http_response_code(201);
        exit;

    case 'PUT':
        if ($rawRelPath === '') {
            http_response_code(405);
            exit;
        }
        $parentRel = dirname($rawRelPath);
        $parentId  = null;
        if ($parentRel !== '' && $parentRel !== '.') {
            $parentResolved = davResolvePath($pdo, $userId, $parentRel);
            if (!$parentResolved || !in_array($parentResolved['type'], ['root', 'folder'], true)) {
                http_response_code(409);
                exit;
            }
            $parentId = $parentResolved['id'];
        }
        $fileName = FileManager::sanitizeName(basename($rawRelPath));
        if ($fileName === '') {
            http_response_code(400);
            exit;
        }

        $tmpFile = Database::CHUNKS_DIR . '/dav_' . bin2hex(random_bytes(10)) . '.tmp';
        $in  = fopen('php://input', 'rb');
        $out = fopen($tmpFile, 'wb');
        if (!$in || !$out) {
            http_response_code(500);
            exit;
        }
        stream_copy_to_stream($in, $out);
        fclose($in);
        fclose($out);

        try {
            $existed = davResolvePath($pdo, $userId, $rawRelPath) !== null;
            FileManager::storeAssembledFile($userId, $parentId, $fileName, $tmpFile);
            http_response_code($existed ? 204 : 201);
        } catch (Throwable $e) {
            @unlink($tmpFile);
            http_response_code(507); // Insufficient Storage
            echo $e->getMessage();
        }
        exit;

    case 'DELETE':
        $resolved = davResolvePath($pdo, $userId, $rawRelPath);
        if (!$resolved || $resolved['type'] === 'root') {
            http_response_code(404);
            exit;
        }
        FileManager::trashItems($userId, [['type' => $resolved['type'], 'id' => $resolved['id']]]);
        http_response_code(204);
        exit;

    case 'MOVE':
    case 'COPY':
        $resolved = davResolvePath($pdo, $userId, $rawRelPath);
        if (!$resolved || $resolved['type'] === 'root') {
            http_response_code(404);
            exit;
        }
        $destHeader = $_SERVER['HTTP_DESTINATION'] ?? '';
        if ($destHeader === '') {
            http_response_code(400);
            exit;
        }
        $destPath = parse_url($destHeader, PHP_URL_PATH) ?: '';
        if (str_starts_with($destPath, $scriptName)) {
            $destRel = substr($destPath, strlen($scriptName));
        } else {
            $destRel = $destPath;
        }
        $destRel = trim(rawurldecode($destRel), '/');
        if ($destRel === '') {
            http_response_code(400);
            exit;
        }

        $destParentRel = dirname($destRel);
        $destParentId  = null;
        if ($destParentRel !== '' && $destParentRel !== '.') {
            $pRes = davResolvePath($pdo, $userId, $destParentRel);
            if (!$pRes || !in_array($pRes['type'], ['root', 'folder'], true)) {
                http_response_code(409);
                exit;
            }
            $destParentId = $pRes['id'];
        }
        $destName = FileManager::sanitizeName(basename($destRel));
        if ($destName === '') {
            http_response_code(400);
            exit;
        }

        if ($method === 'MOVE') {
            $currParentId = $resolved['type'] === 'folder'
                ? ($resolved['row']['parent_id'] !== null ? (int)$resolved['row']['parent_id'] : null)
                : ($resolved['row']['folder_id'] !== null ? (int)$resolved['row']['folder_id'] : null);

            if ($currParentId !== $destParentId) {
                FileManager::moveItems($userId, [['type' => $resolved['type'], 'id' => $resolved['id']]], $destParentId);
            }
            if ($resolved['row']['name'] !== $destName) {
                FileManager::renameItem($userId, $resolved['type'], $resolved['id'], $destName);
            }
            http_response_code(201);
            exit;
        } else {
            // COPY for files
            if ($resolved['type'] === 'file') {
                $srcFile = Database::FILES_DIR . '/' . basename($resolved['row']['storage_name']);
                $tmpCopy = Database::CHUNKS_DIR . '/davcopy_' . bin2hex(random_bytes(8)) . '.tmp';
                if (copy($srcFile, $tmpCopy)) {
                    FileManager::storeAssembledFile($userId, $destParentId, $destName, $tmpCopy);
                    http_response_code(201);
                    exit;
                }
            }
            http_response_code(405);
            exit;
        }

    case 'LOCK':
        $token = 'opaquelocktoken:' . bin2hex(random_bytes(16));
        $pdo->prepare('INSERT OR REPLACE INTO webdav_locks (token, path, owner, expires_at) VALUES (:t, :p, :o, :e)')
            ->execute([':t' => $token, ':p' => $rawRelPath, ':o' => $user['username'], ':e' => time() + 3600]);
        http_response_code(200);
        header('Lock-Token: <' . $token . '>');
        header('Content-Type: application/xml; charset=utf-8');
        echo '<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>' . htmlspecialchars($token, ENT_XML1) . '</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>';
        exit;

    case 'UNLOCK':
        $lockToken = trim((string)($_SERVER['HTTP_LOCK_TOKEN'] ?? ''), '<> ');
        if ($lockToken !== '') {
            $pdo->prepare('DELETE FROM webdav_locks WHERE token = :t')->execute([':t' => $lockToken]);
        }
        http_response_code(204);
        exit;

    default:
        http_response_code(405);
        exit;
}
