#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "☁️  PureCloud läuft auf http://localhost:${PORT}"
echo "📡 WebDAV-Endpunkt:   http://localhost:${PORT}/webdav.php/"
php -S "0.0.0.0:${PORT}"
