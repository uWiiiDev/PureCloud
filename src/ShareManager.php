<?php
declare(strict_types=1);

namespace Cloud;

use PDO;
use RuntimeException;

class ShareManager
{
    public static function assertOwnership(int $userId, string $itemType, int $itemId, bool $allowGroupFolderPublic = false): array
    {
        $pdo = Database::get();
        if ($itemType === 'folder') {
            $stmt = $pdo->prepare('SELECT * FROM folders WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        } elseif ($itemType === 'file') {
            $stmt = $pdo->prepare('SELECT * FROM files WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        } else {
            throw new RuntimeException('Ungültiger Element-Typ.');
        }
        $stmt->execute([':id' => $itemId]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new RuntimeException('Element nicht gefunden.');
        }

        // Check if this folder/file is a Group Folder or inside a Group Folder tree
        $isGroupTree = ($itemType === 'folder' && (int)($row['is_group_folder'] ?? 0) === 1);
        $checkFolderId = $itemType === 'folder'
            ? ($row['parent_id'] !== null ? (int)$row['parent_id'] : null)
            : ($row['folder_id'] !== null ? (int)$row['folder_id'] : null);
        while (!$isGroupTree && $checkFolderId !== null) {
            $pStmt = $pdo->prepare('SELECT parent_id, is_group_folder FROM folders WHERE id = :id LIMIT 1');
            $pStmt->execute([':id' => $checkFolderId]);
            $pRow = $pStmt->fetch();
            if (!$pRow) {
                break;
            }
            if ((int)($pRow['is_group_folder'] ?? 0) === 1) {
                $isGroupTree = true;
                break;
            }
            $checkFolderId = $pRow['parent_id'] !== null ? (int)$pRow['parent_id'] : null;
        }

        if ($isGroupTree) {
            if (!$allowGroupFolderPublic) {
                throw new RuntimeException('Gruppenordner können intern nicht weitergeteilt werden. Öffentliche Links nach außen sind möglich.');
            }
            $access = ($itemType === 'folder')
                ? FileManager::resolveFolderAccess($userId, $itemId)
                : FileManager::resolveFileAccess($userId, $itemId);
            if (!$access) {
                throw new RuntimeException('Kein Zugriff auf diesen Gruppenordner.');
            }
            $row['_is_group_tree'] = true;
            return $row;
        }

        if ((int)$row['owner_id'] !== $userId) {
            throw new RuntimeException('Element nicht gefunden oder Sie sind nicht der Eigentümer.');
        }
        $row['_is_group_tree'] = false;
        return $row;
    }

    public static function getItemShares(int $userId, string $itemType, int $itemId): array
    {
        $item = self::assertOwnership($userId, $itemType, $itemId, true);
        $isGroupTree = !empty($item['_is_group_tree']);
        $pdo  = Database::get();

        if ($isGroupTree) {
            $psStmt = $pdo->prepare('
                SELECT id, token, label, mode, (password_hash IS NOT NULL) AS has_password,
                       expires_at, max_downloads, download_count, created_at
                FROM public_shares
                WHERE item_type = :type AND item_id = :iid
                ORDER BY created_at DESC
            ');
            $psStmt->execute([':type' => $itemType, ':iid' => $itemId]);
        } else {
            $psStmt = $pdo->prepare('
                SELECT id, token, label, mode, (password_hash IS NOT NULL) AS has_password,
                       expires_at, max_downloads, download_count, created_at
                FROM public_shares
                WHERE owner_id = :uid AND item_type = :type AND item_id = :iid
                ORDER BY created_at DESC
            ');
            $psStmt->execute([':uid' => $userId, ':type' => $itemType, ':iid' => $itemId]);
        }
        $publicShares = array_map(fn($r) => [
            'id'             => (int)$r['id'],
            'token'          => $r['token'],
            'label'          => $r['label'],
            'mode'           => $r['mode'],
            'has_password'   => (bool)$r['has_password'],
            'expires_at'     => $r['expires_at'],
            'max_downloads'  => $r['max_downloads'] !== null ? (int)$r['max_downloads'] : null,
            'download_count' => (int)$r['download_count'],
            'created_at'     => $r['created_at'],
        ], $psStmt->fetchAll());

        $usStmt = $pdo->prepare('
            SELECT us.id, us.target_user_id, us.permission, us.created_at,
                   u.username, u.display_name
            FROM user_shares us
            JOIN users u ON u.id = us.target_user_id
            WHERE us.owner_id = :uid AND us.item_type = :type AND us.item_id = :iid
            ORDER BY u.display_name COLLATE NOCASE ASC
        ');
        $usStmt->execute([':uid' => $userId, ':type' => $itemType, ':iid' => $itemId]);
        $userShares = array_map(fn($r) => [
            'id'             => (int)$r['id'],
            'target_user_id' => (int)$r['target_user_id'],
            'username'       => $r['username'],
            'display_name'   => $r['display_name'],
            'permission'     => $r['permission'],
            'created_at'     => $r['created_at'],
        ], $usStmt->fetchAll());

        $uStmt = $pdo->prepare('SELECT id, username, display_name FROM users WHERE id != :uid AND is_active = 1 ORDER BY display_name COLLATE NOCASE ASC');
        $uStmt->execute([':uid' => $userId]);
        $availableUsers = array_map(fn($u) => [
            'id'           => (int)$u['id'],
            'username'     => $u['username'],
            'display_name' => $u['display_name'],
        ], $uStmt->fetchAll());

        $gsStmt = $pdo->prepare('
            SELECT gs.id, gs.target_group_id, gs.permission, gs.created_at, g.name AS group_name
            FROM group_shares gs
            JOIN groups g ON g.id = gs.target_group_id
            WHERE gs.owner_id = :uid AND gs.item_type = :type AND gs.item_id = :iid
            ORDER BY g.name COLLATE NOCASE ASC
        ');
        $gsStmt->execute([':uid' => $userId, ':type' => $itemType, ':iid' => $itemId]);
        $groupShares = array_map(fn($r) => [
            'id'              => (int)$r['id'],
            'target_group_id' => (int)$r['target_group_id'],
            'group_name'      => $r['group_name'],
            'permission'      => $r['permission'],
            'created_at'      => $r['created_at'],
        ], $gsStmt->fetchAll());

        $availableGroups = array_map(fn($g) => [
            'id'   => (int)$g['id'],
            'name' => $g['name'],
        ], $pdo->query('SELECT id, name FROM groups ORDER BY name COLLATE NOCASE ASC')->fetchAll());

        return [
            'item_name'        => $item['name'],
            'item_type'        => $itemType,
            'is_group_tree'    => $isGroupTree,
            'public_shares'    => $publicShares,
            'user_shares'      => $isGroupTree ? [] : $userShares,
            'group_shares'     => $isGroupTree ? [] : $groupShares,
            'available_users'  => $isGroupTree ? [] : $availableUsers,
            'available_groups' => $isGroupTree ? [] : $availableGroups,
        ];
    }

    public static function listMyOutboundShares(int $userId): array
    {
        $pdo = Database::get();
        $psStmt = $pdo->prepare("
            SELECT ps.*,
                   CASE WHEN ps.item_type = 'folder'
                        THEN (SELECT name FROM folders WHERE id = ps.item_id)
                        ELSE (SELECT name FROM files WHERE id = ps.item_id)
                   END AS item_name
            FROM public_shares ps
            WHERE ps.owner_id = :uid
            ORDER BY ps.created_at DESC
        ");
        $psStmt->execute([':uid' => $userId]);
        $publicShares = [];
        foreach ($psStmt->fetchAll() as $r) {
            if ($r['item_name'] === null) {
                continue;
            }
            $publicShares[] = [
                'id'             => (int)$r['id'],
                'item_type'      => $r['item_type'],
                'item_id'        => (int)$r['item_id'],
                'item_name'      => $r['item_name'],
                'token'          => $r['token'],
                'label'          => $r['label'],
                'mode'           => $r['mode'],
                'has_password'   => $r['password_hash'] !== null,
                'expires_at'     => $r['expires_at'],
                'max_downloads'  => $r['max_downloads'] !== null ? (int)$r['max_downloads'] : null,
                'download_count' => (int)$r['download_count'],
                'created_at'     => $r['created_at'],
            ];
        }

        $usStmt = $pdo->prepare("
            SELECT us.*, u.username, u.display_name,
                   CASE WHEN us.item_type = 'folder'
                        THEN (SELECT name FROM folders WHERE id = us.item_id)
                        ELSE (SELECT name FROM files WHERE id = us.item_id)
                   END AS item_name
            FROM user_shares us
            JOIN users u ON u.id = us.target_user_id
            WHERE us.owner_id = :uid
            ORDER BY us.created_at DESC
        ");
        $usStmt->execute([':uid' => $userId]);
        $userShares = [];
        foreach ($usStmt->fetchAll() as $r) {
            if ($r['item_name'] === null) {
                continue;
            }
            $userShares[] = [
                'id'             => (int)$r['id'],
                'item_type'      => $r['item_type'],
                'item_id'        => (int)$r['item_id'],
                'item_name'      => $r['item_name'],
                'target_user_id' => (int)$r['target_user_id'],
                'username'       => $r['username'],
                'display_name'   => $r['display_name'],
                'permission'     => $r['permission'],
                'created_at'     => $r['created_at'],
            ];
        }

        $gsStmt = $pdo->prepare("
            SELECT gs.*, g.name AS group_name,
                   (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
                   CASE WHEN gs.item_type = 'folder'
                        THEN (SELECT name FROM folders WHERE id = gs.item_id AND is_group_folder = 0)
                        ELSE (SELECT name FROM files WHERE id = gs.item_id)
                   END AS item_name
            FROM group_shares gs
            JOIN groups g ON g.id = gs.target_group_id
            WHERE gs.owner_id = :uid
            ORDER BY gs.created_at DESC
        ");
        $gsStmt->execute([':uid' => $userId]);
        $groupShares = [];
        foreach ($gsStmt->fetchAll() as $r) {
            if ($r['item_name'] === null) {
                continue;
            }
            $groupShares[] = [
                'id'              => (int)$r['id'],
                'item_type'       => $r['item_type'],
                'item_id'         => (int)$r['item_id'],
                'item_name'       => $r['item_name'],
                'target_group_id' => (int)$r['target_group_id'],
                'group_name'      => $r['group_name'],
                'permission'      => $r['permission'],
                'created_at'      => $r['created_at'],
            ];
        }

        return [
            'public_shares' => $publicShares,
            'user_shares'   => $userShares,
            'group_shares'  => $groupShares,
        ];
    }

    public static function createPublicShare(
        int $userId,
        string $itemType,
        int $itemId,
        string $mode = 'download',
        ?string $password = null,
        ?string $expiresAt = null,
        ?int $maxDownloads = null,
        string $label = ''
    ): array {
        self::assertOwnership($userId, $itemType, $itemId, true);

        if ($itemType === 'file') {
            $mode = 'download';
        } elseif (!in_array($mode, ['download', 'upload', 'readwrite'], true)) {
            $mode = 'download';
        }

        $pwHash = ($password !== null && trim($password) !== '')
            ? password_hash($password, PASSWORD_DEFAULT)
            : null;

        $exp = ($expiresAt !== null && trim($expiresAt) !== '') ? trim($expiresAt) : null;
        $maxDl = ($maxDownloads !== null && $maxDownloads > 0) ? $maxDownloads : null;
        $token = bin2hex(random_bytes(16));

        $pdo = Database::get();
        $stmt = $pdo->prepare("
            INSERT INTO public_shares (owner_id, item_type, item_id, token, label, mode, password_hash, expires_at, max_downloads, download_count, created_at)
            VALUES (:uid, :type, :iid, :tok, :lbl, :mode, :pw, :exp, :maxdl, 0, datetime('now'))
        ");
        $stmt->execute([
            ':uid'   => $userId,
            ':type'  => $itemType,
            ':iid'   => $itemId,
            ':tok'   => $token,
            ':lbl'   => trim($label),
            ':mode'  => $mode,
            ':pw'    => $pwHash,
            ':exp'   => $exp,
            ':maxdl' => $maxDl,
        ]);

        return [
            'id'    => (int)$pdo->lastInsertId(),
            'token' => $token,
        ];
    }

    public static function deletePublicShare(int $userId, int $shareId): void
    {
        $pdo = Database::get();
        $stmt = $pdo->prepare('DELETE FROM public_shares WHERE id = :id AND owner_id = :uid');
        $stmt->execute([':id' => $shareId, ':uid' => $userId]);
    }

    public static function setUserShare(int $userId, string $itemType, int $itemId, int $targetUserId, string $permission): void
    {
        if ($targetUserId === $userId) {
            throw new RuntimeException('Sie können kein Element mit sich selbst teilen.');
        }
        self::assertOwnership($userId, $itemType, $itemId);
        if (!in_array($permission, ['read', 'write'], true)) {
            $permission = 'read';
        }

        $pdo = Database::get();
        $stmt = $pdo->prepare("
            INSERT INTO user_shares (owner_id, target_user_id, item_type, item_id, permission, created_at)
            VALUES (:uid, :tuid, :type, :iid, :perm, datetime('now'))
            ON CONFLICT(target_user_id, item_type, item_id)
            DO UPDATE SET permission = excluded.permission
        ");
        $stmt->execute([
            ':uid'  => $userId,
            ':tuid' => $targetUserId,
            ':type' => $itemType,
            ':iid'  => $itemId,
            ':perm' => $permission,
        ]);
    }

    public static function deleteUserShare(int $userId, int $shareId): void
    {
        $pdo = Database::get();
        $stmt = $pdo->prepare('DELETE FROM user_shares WHERE id = :id AND owner_id = :uid');
        $stmt->execute([':id' => $shareId, ':uid' => $userId]);
    }

    public static function setGroupShare(int $userId, string $itemType, int $itemId, int $targetGroupId, string $permission): void
    {
        self::assertOwnership($userId, $itemType, $itemId);
        if (!in_array($permission, ['read', 'write'], true)) {
            $permission = 'read';
        }

        $pdo = Database::get();
        $stmt = $pdo->prepare("
            INSERT INTO group_shares (owner_id, target_group_id, item_type, item_id, permission, created_at)
            VALUES (:uid, :tgid, :type, :iid, :perm, datetime('now'))
            ON CONFLICT(target_group_id, item_type, item_id)
            DO UPDATE SET permission = excluded.permission
        ");
        $stmt->execute([
            ':uid'  => $userId,
            ':tgid' => $targetGroupId,
            ':type' => $itemType,
            ':iid'  => $itemId,
            ':perm' => $permission,
        ]);
    }

    public static function deleteGroupShare(int $userId, int $shareId): void
    {
        $pdo = Database::get();
        $stmt = $pdo->prepare('DELETE FROM group_shares WHERE id = :id AND owner_id = :uid');
        $stmt->execute([':id' => $shareId, ':uid' => $userId]);
    }

    public static function resolvePublicToken(string $token): ?array
    {
        $token = trim($token);
        if ($token === '') {
            return null;
        }
        $pdo = Database::get();
        $stmt = $pdo->prepare('SELECT * FROM public_shares WHERE token = :tok LIMIT 1');
        $stmt->execute([':tok' => $token]);
        $share = $stmt->fetch();
        if (!$share) {
            return null;
        }

        if ($share['expires_at'] !== null && strtotime($share['expires_at'] . ' 23:59:59') < time()) {
            return null;
        }
        if ($share['max_downloads'] !== null && (int)$share['download_count'] >= (int)$share['max_downloads']) {
            return null;
        }

        if ($share['item_type'] === 'file') {
            $iStmt = $pdo->prepare('SELECT * FROM files WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        } else {
            $iStmt = $pdo->prepare('SELECT * FROM folders WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        }
        $iStmt->execute([':id' => (int)$share['item_id']]);
        $item = $iStmt->fetch();
        if (!$item) {
            return null;
        }

        return [
            'share' => $share,
            'item'  => $item,
        ];
    }
}
