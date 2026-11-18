<?php
declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

use Cloud\Database;

// Serve dynamic PNG App Icon (192x192 or 512x512) for universal Android/iOS/Desktop PWA compatibility
if (isset($_GET['icon'])) {
    $size = ((int)$_GET['icon'] === 512) ? 512 : 192;
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=604800');

    if (function_exists('imagecreatetruecolor')) {
        $img = imagecreatetruecolor($size, $size);
        imagealphablending($img, true);
        imagesavealpha($img, true);

        // Background #0f172a & primary blue accent #3b82f6
        $bg   = imagecolorallocate($img, 15, 23, 42);
        $blue = imagecolorallocate($img, 59, 130, 246);
        $white = imagecolorallocate($img, 248, 250, 252);

        imagefilledrectangle($img, 0, 0, $size, $size, $bg);

        // Draw stylized cloud silhouette in center
        $cx = (int)($size * 0.5);
        $cy = (int)($size * 0.54);
        $r1 = (int)($size * 0.34);
        $r2 = (int)($size * 0.26);
        $r3 = (int)($size * 0.22);

        // Blue outer glow ring
        imagefilledellipse($img, $cx, (int)($size * 0.5), (int)($size * 0.78), (int)($size * 0.78), $blue);
        // White cloud lobes
        imagefilledellipse($img, $cx - (int)($size * 0.04), $cy - (int)($size * 0.07), $r1, $r1, $white);
        imagefilledellipse($img, $cx - (int)($size * 0.16), $cy + (int)($size * 0.02), $r2, $r2, $white);
        imagefilledellipse($img, $cx + (int)($size * 0.14), $cy + (int)($size * 0.03), $r3, $r3, $white);
        imagefilledrectangle(
            $img,
            $cx - (int)($size * 0.16),
            $cy,
            $cx + (int)($size * 0.14),
            $cy + (int)($size * 0.13),
            $white
        );

        imagepng($img);
        imagedestroy($img);
        exit;
    }
    exit;
}

$settings = Database::getSettings();
$appName  = $settings['app_name'] ?? 'PureCloud';

header('Content-Type: application/manifest+json; charset=utf-8');
header('Cache-Control: no-cache');

$manifest = [
    'id'               => './',
    'name'             => $appName,
    'short_name'       => $appName,
    'description'      => $appName . ' – Schnelle, sichere Datei-Cloud',
    'start_url'        => './',
    'scope'            => './',
    'display'          => 'standalone',
    'orientation'      => 'any',
    'background_color' => '#0f172a',
    'theme_color'      => '#0f172a',
    'icons'            => [
        [
            'src'     => 'manifest.php?icon=192',
            'sizes'   => '192x192',
            'type'    => 'image/png',
            'purpose' => 'any maskable',
        ],
        [
            'src'     => 'manifest.php?icon=512',
            'sizes'   => '512x512',
            'type'    => 'image/png',
            'purpose' => 'any maskable',
        ],
    ],
];

echo json_encode($manifest, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
