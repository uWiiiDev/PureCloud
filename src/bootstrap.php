<?php
declare(strict_types=1);

spl_autoload_register(function (string $class): void {
    $prefix = 'Cloud\\';
    if (str_starts_with($class, $prefix)) {
        $rel = substr($class, strlen($prefix));
        $file = __DIR__ . '/' . str_replace('\\', '/', $rel) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});

// Initialize directories & SQLite connection on startup
\Cloud\Database::get();
