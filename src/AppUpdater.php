<?php
declare(strict_types=1);

namespace Cloud;

use PDO;
use RuntimeException;
use Throwable;
use ZipArchive;

class AppUpdater
{
    public const DEFAULT_REPO   = 'uWiiiDev/PureCloud';
    public const DEFAULT_BRANCH = 'main';

    public static function getAppRoot(): string
    {
        return realpath(__DIR__ . '/..') ?: dirname(__DIR__);
    }

    public static function getCurrentVersion(): array
    {
        $appRoot = self::getAppRoot();
        $pdo = Database::get();

        $sha = '';
        $date = '';
        $message = '';
        $isGit = false;

        // Check if git is available in project root
        if (is_dir($appRoot . '/.git')) {
            $headFile = $appRoot . '/.git/HEAD';
            if (is_file($headFile)) {
                $headContent = trim((string)file_get_contents($headFile));
                if (str_starts_with($headContent, 'ref: ')) {
                    $ref = trim(substr($headContent, 5));
                    $refFile = $appRoot . '/.git/' . $ref;
                    if (is_file($refFile)) {
                        $sha = trim((string)file_get_contents($refFile));
                        $isGit = true;
                    }
                } elseif (strlen($headContent) >= 40) {
                    $sha = $headContent;
                    $isGit = true;
                }
            }

            if ($sha !== '' && function_exists('shell_exec')) {
                $gitLog = @shell_exec('cd ' . escapeshellarg($appRoot) . ' && git log -1 --format="%cI|%s" 2>/dev/null');
                if ($gitLog && str_contains($gitLog, '|')) {
                    [$gDate, $gMsg] = explode('|', trim($gitLog), 2);
                    $date = trim($gDate);
                    $message = trim($gMsg);
                }
            }
        }

        // Fallback to SQLite settings
        if ($sha === '') {
            $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :k');
            $stmt->execute([':k' => 'installed_commit_sha']);
            $sha = (string)($stmt->fetchColumn() ?: '22f3e36');
        }

        if ($date === '') {
            $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :k');
            $stmt->execute([':k' => 'installed_commit_date']);
            $date = (string)($stmt->fetchColumn() ?: '');
        }

        if ($message === '') {
            $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :k');
            $stmt->execute([':k' => 'installed_commit_msg']);
            $message = (string)($stmt->fetchColumn() ?: '');
        }

        $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :k');
        $stmt->execute([':k' => 'github_repo']);
        $repo = (string)($stmt->fetchColumn() ?: self::DEFAULT_REPO);

        $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = :k');
        $stmt->execute([':k' => 'github_branch']);
        $branch = (string)($stmt->fetchColumn() ?: self::DEFAULT_BRANCH);

        return [
            'sha'        => $sha,
            'short_sha'  => substr($sha, 0, 7),
            'date'       => $date,
            'message'    => $message,
            'is_git'     => $isGit,
            'repo'       => $repo,
            'branch'     => $branch,
        ];
    }

    public static function checkUpdate(): array
    {
        $current = self::getCurrentVersion();
        $repo = $current['repo'] ?: self::DEFAULT_REPO;
        $branch = $current['branch'] ?: self::DEFAULT_BRANCH;

        $url = "https://api.github.com/repos/{$repo}/commits/{$branch}";
        $ctx = stream_context_create([
            'http' => [
                'header'          => "User-Agent: PureCloud-Updater\r\nAccept: application/vnd.github.v3+json\r\n",
                'timeout'         => 12,
                'follow_location' => 1,
            ],
            'ssl' => [
                'verify_peer'      => true,
                'verify_peer_name' => true,
            ]
        ]);

        $raw = @file_get_contents($url, false, $ctx);
        if ($raw === false) {
            throw new RuntimeException("Verbindung zu GitHub ({$repo}) fehlgeschlagen. Bitte Internetverbindung prüfen.");
        }

        $json = json_decode($raw, true);
        if (!is_array($json) || empty($json['sha'])) {
            $msg = $json['message'] ?? 'Ungültige Antwort von GitHub.';
            throw new RuntimeException("GitHub API Fehler: {$msg}");
        }

        $latestSha  = (string)$json['sha'];
        $commitDate = (string)($json['commit']['committer']['date'] ?? $json['commit']['author']['date'] ?? '');
        $commitMsg  = trim((string)($json['commit']['message'] ?? ''));
        $firstLine  = explode("\n", $commitMsg)[0] ?? $commitMsg;
        $author     = (string)($json['commit']['author']['name'] ?? $json['author']['login'] ?? '');
        $htmlUrl    = (string)($json['html_url'] ?? "https://github.com/{$repo}/commit/{$latestSha}");

        $hasUpdate = (strtolower($current['sha']) !== strtolower($latestSha) &&
                      strtolower($current['short_sha']) !== strtolower(substr($latestSha, 0, 7)));

        // Record check timestamp
        $pdo = Database::get();
        $pdo->prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)')->execute([
            ':k' => 'last_update_check',
            ':v' => date('Y-m-d H:i:s'),
        ]);

        return [
            'current' => $current,
            'latest'  => [
                'sha'       => $latestSha,
                'short_sha' => substr($latestSha, 0, 7),
                'date'      => $commitDate,
                'message'   => $firstLine,
                'author'    => $author,
                'html_url'  => $htmlUrl,
            ],
            'has_update' => $hasUpdate,
        ];
    }

    public static function performUpdate(): array
    {
        $appRoot = self::getAppRoot();
        $check = self::checkUpdate();
        $latest = $check['latest'];
        $repo = $check['current']['repo'] ?: self::DEFAULT_REPO;
        $branch = $check['current']['branch'] ?: self::DEFAULT_BRANCH;

        // Strategy 1: If .git directory exists and git command is available
        if (is_dir($appRoot . '/.git') && function_exists('exec')) {
            $out = [];
            $code = 0;
            @exec("cd " . escapeshellarg($appRoot) . " && git fetch origin " . escapeshellarg($branch) . " 2>&1 && git reset --hard origin/" . escapeshellarg($branch) . " 2>&1", $out, $code);
            if ($code === 0) {
                return self::finalizeUpdate($latest['sha'], $latest['date'], $latest['message'], 'git');
            }
        }

        // Strategy 2: Universal ZIP download & extraction
        if (!class_exists('ZipArchive')) {
            throw new RuntimeException('PHP-Erweiterung ZipArchive ist auf diesem Server nicht installiert.');
        }

        Database::ensureDirectories();
        $zipUrl = "https://codeload.github.com/{$repo}/zip/refs/heads/{$branch}";
        $tmpZip = Database::CHUNKS_DIR . '/purecloud_upd_' . bin2hex(random_bytes(8)) . '.zip';

        $ctx = stream_context_create([
            'http' => [
                'header'          => "User-Agent: PureCloud-Updater\r\n",
                'timeout'         => 60,
                'follow_location' => 1,
            ],
            'ssl' => [
                'verify_peer'      => true,
                'verify_peer_name' => true,
            ]
        ]);

        $in = @fopen($zipUrl, 'rb', false, $ctx);
        if (!$in) {
            throw new RuntimeException("Konnte ZIP-Archiv von {$zipUrl} nicht herunterladen.");
        }
        $out = fopen($tmpZip, 'wb');
        if (!$out) {
            fclose($in);
            throw new RuntimeException('Konnte temporäre Update-Datei nicht anlegen.');
        }
        stream_copy_to_stream($in, $out);
        fclose($in);
        fclose($out);

        $zip = new ZipArchive();
        if ($zip->open($tmpZip) !== true) {
            @unlink($tmpZip);
            throw new RuntimeException('Heruntergeladene Update-Datei ist kein gültiges ZIP-Archiv.');
        }

        // Determine top-level prefix inside zip, e.g. "PureCloud-main/"
        $prefix = '';
        if ($zip->numFiles > 0) {
            $first = $zip->getNameIndex(0);
            if (str_contains($first, '/')) {
                $prefix = explode('/', $first)[0] . '/';
            }
        }

        // Protected directories that must NEVER be overwritten from the zip
        $protectedPrefixes = ['storage/', 'storage\\'];

        $updatedCount = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entryName = $zip->getNameIndex($i);
            if ($prefix !== '' && str_starts_with($entryName, $prefix)) {
                $relPath = substr($entryName, strlen($prefix));
            } else {
                $relPath = $entryName;
            }

            if ($relPath === '' || $relPath === '.' || $relPath === './') {
                continue;
            }

            // Path traversal protection
            $relPathClean = str_replace('\\', '/', $relPath);
            if (str_starts_with($relPathClean, '/') || str_contains($relPathClean, '../') || str_contains($relPathClean, '..\\')) {
                continue;
            }

            // STRICT PROTECTION: Never touch storage/ directory or contents!
            $skip = false;
            foreach ($protectedPrefixes as $pp) {
                if (str_starts_with($relPathClean, $pp) || $relPathClean === rtrim($pp, '/\\')) {
                    $skip = true;
                    break;
                }
            }
            if ($skip) {
                continue;
            }

            $targetPath = $appRoot . '/' . $relPathClean;

            // Directory entry
            if (str_ends_with($relPathClean, '/')) {
                if (!is_dir($targetPath)) {
                    @mkdir($targetPath, 0755, true);
                }
                continue;
            }

            // Ensure parent directory exists
            $parentDir = dirname($targetPath);
            if (!is_dir($parentDir)) {
                @mkdir($parentDir, 0755, true);
            }

            // Extract file content
            $content = $zip->getFromIndex($i);
            if ($content === false) {
                continue;
            }

            if (@file_put_contents($targetPath, $content, LOCK_EX) !== false) {
                $updatedCount++;
            }
        }

        $zip->close();
        @unlink($tmpZip);

        return self::finalizeUpdate($latest['sha'], $latest['date'], $latest['message'], 'zip', $updatedCount);
    }

    private static function finalizeUpdate(string $sha, string $date, string $msg, string $method, int $filesCount = 0): array
    {
        // Reset PHP opcache if enabled
        if (function_exists('opcache_reset')) {
            @opcache_reset();
        }

        // Trigger automatic database schema migrations
        try {
            Database::get();
        } catch (Throwable $e) {
            // Log but don't fail update
        }

        // Store new version in settings
        $pdo = Database::get();
        $stmt = $pdo->prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)');
        $stmt->execute([':k' => 'installed_commit_sha', ':v' => $sha]);
        if ($date !== '') {
            $stmt->execute([':k' => 'installed_commit_date', ':v' => $date]);
        }
        if ($msg !== '') {
            $stmt->execute([':k' => 'installed_commit_msg', ':v' => $msg]);
        }
        $stmt->execute([':k' => 'last_update_installed_at', ':v' => date('Y-m-d H:i:s')]);

        return [
            'ok'          => true,
            'method'      => $method,
            'sha'         => $sha,
            'short_sha'   => substr($sha, 0, 7),
            'message'     => $msg,
            'files_count' => $filesCount,
        ];
    }
}
