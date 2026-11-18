<?php
declare(strict_types=1);

namespace Cloud;

use PDO;
use RuntimeException;

class TwoFactor
{
    // =========================================================================
    // 1. TOTP (RFC 6238 Authenticator App) & Local SVG QR Code
    // =========================================================================

    public static function generateTotpSecret(int $length = 32): string
    {
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        $secret = '';
        for ($i = 0; $i < $length; $i++) {
            $secret .= $alphabet[random_int(0, 31)];
        }
        return $secret;
    }

    public static function base32Decode(string $base32): string
    {
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        $clean = strtoupper((string)preg_replace('/[^A-Za-z2-7]/', '', $base32));
        $buffer = 0;
        $bitsLeft = 0;
        $out = '';
        $len = strlen($clean);
        for ($i = 0; $i < $len; $i++) {
            $val = strpos($alphabet, $clean[$i]);
            if ($val === false) {
                continue;
            }
            $buffer = ($buffer << 5) | $val;
            $bitsLeft += 5;
            if ($bitsLeft >= 8) {
                $bitsLeft -= 8;
                $out .= chr(($buffer >> $bitsLeft) & 0xFF);
            }
        }
        return $out;
    }

    public static function getTotpCode(string $base32Secret, ?int $timeSlice = null): string
    {
        if ($timeSlice === null) {
            $timeSlice = (int)floor(time() / 30);
        }
        $secretKey = self::base32Decode($base32Secret);
        if ($secretKey === '') {
            return '';
        }
        $timeBytes = pack('N*', 0, $timeSlice);
        $hmac = hash_hmac('sha1', $timeBytes, $secretKey, true);
        $offset = ord($hmac[19]) & 0x0F;
        $binary = ((ord($hmac[$offset]) & 0x7F) << 24)
            | ((ord($hmac[$offset + 1]) & 0xFF) << 16)
            | ((ord($hmac[$offset + 2]) & 0xFF) << 8)
            | (ord($hmac[$offset + 3]) & 0xFF);
        $otp = $binary % 1000000;
        return str_pad((string)$otp, 6, '0', STR_PAD_LEFT);
    }

    public static function verifyTotpCode(string $base32Secret, string $codeInput, int $window = 1): bool
    {
        $cleanCode = (string)preg_replace('/\s+/', '', trim($codeInput));
        if (!preg_match('/^\d{6}$/', $cleanCode) || trim($base32Secret) === '') {
            return false;
        }
        $currentSlice = (int)floor(time() / 30);
        for ($i = -$window; $i <= $window; $i++) {
            $calc = self::getTotpCode($base32Secret, $currentSlice + $i);
            if ($calc !== '' && hash_equals($calc, $cleanCode)) {
                return true;
            }
        }
        return false;
    }

    public static function buildOtpAuthUri(string $issuer, string $username, string $secret): string
    {
        $cleanIssuer = trim((string)preg_replace('/[:\r\n]/', ' ', $issuer)) ?: 'PureCloud';
        $cleanUser   = trim((string)preg_replace('/[:\r\n]/', '_', $username)) ?: 'user';
        $label       = rawurlencode($cleanIssuer) . ':' . rawurlencode($cleanUser);
        return sprintf(
            'otpauth://totp/%s?secret=%s&issuer=%s&algorithm=SHA1&digits=6&period=30',
            $label,
            rawurlencode($secret),
            rawurlencode($cleanIssuer)
        );
    }

    public static function renderQrCodeSvg(string $data, int $pixelSize = 180): string
    {
        $versions = [
            1  => [26,   7,  1, 19,  0, 0,  []],
            2  => [44,   10, 1, 34,  0, 0,  [6, 18]],
            3  => [70,   15, 1, 55,  0, 0,  [6, 22]],
            4  => [100,  20, 1, 80,  0, 0,  [6, 26]],
            5  => [134,  26, 1, 108, 0, 0,  [6, 30]],
            6  => [172,  18, 2, 68,  0, 0,  [6, 34]],
            7  => [196,  20, 2, 78,  0, 0,  [6, 22, 38]],
            8  => [242,  24, 2, 97,  0, 0,  [6, 24, 42]],
            9  => [292,  30, 2, 116, 0, 0,  [6, 26, 46]],
            10 => [346,  18, 2, 68,  2, 69, [6, 28, 50]],
        ];

        $dataLen = strlen($data);
        $ver = 0;
        foreach ($versions as $v => $cfg) {
            $totalDataCw = $cfg[2] * $cfg[3] + $cfg[4] * $cfg[5];
            $headerBits = ($v <= 9) ? 12 : 20;
            $maxBytes = (int)floor(($totalDataCw * 8 - $headerBits) / 8);
            if ($dataLen <= $maxBytes) {
                $ver = $v;
                break;
            }
        }
        if ($ver === 0) {
            return '';
        }

        [, $ecCwPerBlock, $b1, $d1, $b2, $d2, $align] = $versions[$ver];
        $totalDataCw = $b1 * $d1 + $b2 * $d2;

        $bits = '0100';
        $lenBits = ($ver <= 9) ? 8 : 16;
        $bits .= str_pad(decbin($dataLen), $lenBits, '0', STR_PAD_LEFT);
        for ($i = 0; $i < $dataLen; $i++) {
            $bits .= str_pad(decbin(ord($data[$i])), 8, '0', STR_PAD_LEFT);
        }

        $maxDataBits = $totalDataCw * 8;
        $terminator = min(4, $maxDataBits - strlen($bits));
        if ($terminator > 0) {
            $bits .= str_repeat('0', $terminator);
        }
        while ((strlen($bits) % 8) !== 0) {
            $bits .= '0';
        }

        $padBytes = ['11101100', '00010001'];
        $pIdx = 0;
        while (strlen($bits) < $maxDataBits) {
            $bits .= $padBytes[$pIdx % 2];
            $pIdx++;
        }

        $dataCodewords = [];
        for ($i = 0; $i < $totalDataCw; $i++) {
            $dataCodewords[] = (int)bindec(substr($bits, $i * 8, 8));
        }

        $gfExp = array_fill(0, 512, 0);
        $gfLog = array_fill(0, 256, 0);
        $x = 1;
        for ($i = 0; $i < 255; $i++) {
            $gfExp[$i] = $x;
            $gfLog[$x] = $i;
            $x <<= 1;
            if ($x & 0x100) {
                $x ^= 0x11D;
            }
        }
        for ($i = 255; $i < 512; $i++) {
            $gfExp[$i] = $gfExp[$i - 255];
        }

        $gfMul = static function (int $a, int $b) use ($gfExp, $gfLog): int {
            if ($a === 0 || $b === 0) {
                return 0;
            }
            return $gfExp[$gfLog[$a] + $gfLog[$b]];
        };

        $gen = [1];
        for ($i = 0; $i < $ecCwPerBlock; $i++) {
            $next = array_fill(0, count($gen) + 1, 0);
            for ($j = 0, $gLen = count($gen); $j < $gLen; $j++) {
                $next[$j] ^= $gen[$j];
                $next[$j + 1] ^= $gfMul($gen[$j], $gfExp[$i]);
            }
            $gen = $next;
        }

        $dataBlocks = [];
        $ecBlocks = [];
        $offset = 0;
        $blockCounts = array_merge(array_fill(0, $b1, $d1), $b2 > 0 ? array_fill(0, $b2, $d2) : []);

        foreach ($blockCounts as $bLen) {
            $block = array_slice($dataCodewords, $offset, $bLen);
            $offset += $bLen;
            $dataBlocks[] = $block;

            $msg = array_merge($block, array_fill(0, $ecCwPerBlock, 0));
            for ($i = 0; $i < $bLen; $i++) {
                $coef = $msg[$i];
                if ($coef !== 0) {
                    for ($j = 0; $j <= $ecCwPerBlock; $j++) {
                        $msg[$i + $j] ^= $gfMul($gen[$j], $coef);
                    }
                }
            }
            $ecBlocks[] = array_slice($msg, $bLen);
        }

        $finalCw = [];
        $maxDataBlockLen = max($d1, $d2);
        for ($i = 0; $i < $maxDataBlockLen; $i++) {
            foreach ($dataBlocks as $blk) {
                if (isset($blk[$i])) {
                    $finalCw[] = $blk[$i];
                }
            }
        }
        for ($i = 0; $i < $ecCwPerBlock; $i++) {
            foreach ($ecBlocks as $eblk) {
                $finalCw[] = $eblk[$i];
            }
        }

        $dim = 17 + 4 * $ver;
        $matrix = array_fill(0, $dim, array_fill(0, $dim, null));
        $reserved = array_fill(0, $dim, array_fill(0, $dim, false));

        $placeFinder = static function (int $r0, int $c0) use (&$matrix, &$reserved, $dim): void {
            for ($r = -1; $r <= 7; $r++) {
                for ($c = -1; $c <= 7; $c++) {
                    $rr = $r0 + $r;
                    $cc = $c0 + $c;
                    if ($rr < 0 || $rr >= $dim || $cc < 0 || $cc >= $dim) {
                        continue;
                    }
                    $inOuter = ($r >= 0 && $r <= 6 && $c >= 0 && $c <= 6);
                    $inBorder = ($r === 0 || $r === 6 || $c === 0 || $c === 6);
                    $inCenter = ($r >= 2 && $r <= 4 && $c >= 2 && $c <= 4);
                    $matrix[$rr][$cc] = ($inOuter && ($inBorder || $inCenter)) ? 1 : 0;
                    $reserved[$rr][$cc] = true;
                }
            }
        };

        $placeFinder(0, 0);
        $placeFinder(0, $dim - 7);
        $placeFinder($dim - 7, 0);

        $aCount = count($align);
        for ($i = 0; $i < $aCount; $i++) {
            for ($j = 0; $j < $aCount; $j++) {
                if (($i === 0 && $j === 0) || ($i === 0 && $j === $aCount - 1) || ($i === $aCount - 1 && $j === 0)) {
                    continue;
                }
                $ar = $align[$i];
                $ac = $align[$j];
                for ($r = -2; $r <= 2; $r++) {
                    for ($c = -2; $c <= 2; $c++) {
                        $matrix[$ar + $r][$ac + $c] = (abs($r) === 2 || abs($c) === 2 || ($r === 0 && $c === 0)) ? 1 : 0;
                        $reserved[$ar + $r][$ac + $c] = true;
                    }
                }
            }
        }

        for ($i = 8; $i < $dim - 8; $i++) {
            if (!$reserved[6][$i]) {
                $matrix[6][$i] = ($i % 2 === 0) ? 1 : 0;
                $reserved[6][$i] = true;
            }
            if (!$reserved[$i][6]) {
                $matrix[$i][6] = ($i % 2 === 0) ? 1 : 0;
                $reserved[$i][6] = true;
            }
        }

        $matrix[4 * $ver + 9][8] = 1;
        $reserved[4 * $ver + 9][8] = true;
        for ($i = 0; $i < 9; $i++) {
            if ($i < $dim) {
                $reserved[8][$i] = true;
                $reserved[$i][8] = true;
            }
        }
        for ($i = 0; $i < 8; $i++) {
            $reserved[8][$dim - 1 - $i] = true;
            $reserved[$dim - 1 - $i][8] = true;
        }

        if ($ver >= 7) {
            $vInfo = $ver << 12;
            for ($i = 5; $i >= 0; $i--) {
                if ($vInfo & (1 << ($i + 12))) {
                    $vInfo ^= (0x1F25 << $i);
                }
            }
            $vBits = ($ver << 12) | $vInfo;
            for ($i = 0; $i < 18; $i++) {
                $bit = ($vBits >> $i) & 1;
                $r = (int)floor($i / 3);
                $c = $dim - 11 + ($i % 3);
                $matrix[$r][$c] = $bit;
                $reserved[$r][$c] = true;
                $matrix[$c][$r] = $bit;
                $reserved[$c][$r] = true;
            }
        }

        $allBits = '';
        foreach ($finalCw as $cw) {
            $allBits .= str_pad(decbin($cw), 8, '0', STR_PAD_LEFT);
        }
        $allBits .= str_repeat('0', 7);

        $bitIdx = 0;
        $totalBitsLen = strlen($allBits);
        $up = true;
        for ($col = $dim - 1; $col > 0; $col -= 2) {
            if ($col === 6) {
                $col--;
            }
            for ($step = 0; $step < $dim; $step++) {
                $row = $up ? ($dim - 1 - $step) : $step;
                for ($cOff = 0; $cOff < 2; $cOff++) {
                    $cc = $col - $cOff;
                    if (!$reserved[$row][$cc]) {
                        $bit = ($bitIdx < $totalBitsLen && $allBits[$bitIdx] === '1') ? 1 : 0;
                        $bitIdx++;
                        if ((($row + $cc) % 2) === 0) {
                            $bit ^= 1;
                        }
                        $matrix[$row][$cc] = $bit;
                    }
                }
            }
            $up = !$up;
        }

        $fmtBits = 0x77C4;
        $fCoords1 = [
            [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
            [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
        ];
        for ($i = 0; $i < 15; $i++) {
            $bit = ($fmtBits >> $i) & 1;
            [$r1, $c1] = $fCoords1[$i];
            $matrix[$r1][$c1] = $bit;
            if ($i < 8) {
                $matrix[8][$dim - 1 - $i] = $bit;
            } else {
                $matrix[$dim - 15 + $i][8] = $bit;
            }
        }

        $margin = 2;
        $viewSize = $dim + 2 * $margin;
        $pathParts = [];
        for ($r = 0; $r < $dim; $r++) {
            for ($c = 0; $c < $dim; $c++) {
                if ($matrix[$r][$c] === 1) {
                    $pathParts[] = sprintf('M%d,%dh1v1h-1z', $c + $margin, $r + $margin);
                }
            }
        }

        return sprintf(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" shape-rendering="crispEdges" style="border-radius:10px;background:#fff;padding:6px;border:1px solid #cbd5e1"><rect width="100%%" height="100%%" fill="#ffffff"/><path d="%s" fill="#0f172a"/></svg>',
            $viewSize,
            $viewSize,
            $pixelSize,
            $pixelSize,
            implode('', $pathParts)
        );
    }

    // =========================================================================
    // 2. E-Mail 2FA (6-Digit Code via PHP mail() or SMTP)
    // =========================================================================

    public static function maskEmail(string $email): string
    {
        $email = trim($email);
        if (!str_contains($email, '@')) {
            return '***';
        }
        [$local, $domain] = explode('@', $email, 2);
        $maskedLocal = strlen($local) <= 2
            ? substr($local, 0, 1) . '*'
            : substr($local, 0, 2) . str_repeat('*', max(2, strlen($local) - 2));
        return $maskedLocal . '@' . $domain;
    }

    public static function sendEmailCode(int $userId): string
    {
        $pdo = Database::get();
        $stmt = $pdo->prepare('SELECT username, display_name, email FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $user = $stmt->fetch();
        if (!$user || trim((string)$user['email']) === '') {
            throw new RuntimeException('Für dieses Konto ist keine E-Mail-Adresse hinterlegt.');
        }

        $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $hash = password_hash($code, PASSWORD_DEFAULT);
        $expires = time() + 600; // 10 minutes

        $pdo->prepare('UPDATE users SET email_code_hash = :h, email_code_expires = :e WHERE id = :id')
            ->execute([':h' => $hash, ':e' => $expires, ':id' => $userId]);

        $settings = Database::getSettings();
        $appName  = $settings['app_name'] ?? 'PureCloud';
        $subject  = sprintf('[%s] Ihr Anmeldecode: %s', $appName, $code);
        $body     = implode("\r\n", [
            sprintf('Hallo %s,', $user['display_name'] ?: $user['username']),
            '',
            sprintf('Ihr einmaliger Sicherheitscode für die Anmeldung bei %s lautet:', $appName),
            '',
            '    ' . $code,
            '',
            'Dieser Code ist 10 Minuten lang gültig.',
        ]);

        self::sendSystemEmail($user['email'], $subject, $body);
        return self::maskEmail($user['email']);
    }

    public static function verifyEmailCode(int $userId, string $codeInput): bool
    {
        $clean = (string)preg_replace('/\s+/', '', trim($codeInput));
        if (!preg_match('/^\d{6}$/', $clean)) {
            return false;
        }
        $pdo = Database::get();
        $stmt = $pdo->prepare('SELECT email_code_hash, email_code_expires FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $row = $stmt->fetch();
        if (!$row || empty($row['email_code_hash']) || time() > (int)$row['email_code_expires']) {
            return false;
        }
        if (!password_verify($clean, (string)$row['email_code_hash'])) {
            return false;
        }
        $pdo->prepare('UPDATE users SET email_code_hash = NULL, email_code_expires = 0 WHERE id = :id')
            ->execute([':id' => $userId]);
        return true;
    }

    public static function sendSystemEmail(string $toEmail, string $rawSubject, string $body): void
    {
        $toEmail = trim($toEmail);
        if (filter_var($toEmail, FILTER_VALIDATE_EMAIL) === false) {
            throw new RuntimeException('Ungültige E-Mail-Adresse.');
        }

        $settings = Database::getSettings();
        $appName  = preg_replace('/[\r\n"]/', '', $settings['app_name'] ?? 'PureCloud') ?: 'PureCloud';
        $rawHost  = trim((string)($_SERVER['HTTP_HOST'] ?? 'runready.cloud'));
        $domain   = preg_replace('/:\d+$/', '', $rawHost) ?: 'runready.cloud';
        if ($domain === 'localhost' || filter_var($domain, FILTER_VALIDATE_IP) !== false) {
            $domain = 'runready.cloud';
        }

        $fromEmail = !empty($settings['mail_from']) && filter_var($settings['mail_from'], FILTER_VALIDATE_EMAIL)
            ? $settings['mail_from']
            : ('noreply@' . $domain);

        $encodedFromName = '=?UTF-8?B?' . base64_encode($appName) . '?=';
        $encodedSubject  = '=?UTF-8?B?' . base64_encode($rawSubject) . '?=';

        $headers = implode("\r\n", [
            'From: ' . $encodedFromName . ' <' . $fromEmail . '>',
            'Reply-To: ' . $fromEmail,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
        ]);

        $sent = @mail($toEmail, $encodedSubject, $body, $headers, '-f ' . escapeshellarg($fromEmail));
        if (!$sent) {
            $sent = @mail($toEmail, $encodedSubject, $body, $headers);
        }
        if (!$sent) {
            throw new RuntimeException('E-Mail-Versand über den Server ist fehlgeschlagen.');
        }
    }

    // =========================================================================
    // 3. WebAuthn / Biometrie Passkeys (Fingerabdruck, FaceID, Windows Hello)
    // =========================================================================

    public static function b64urlEncode(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    public static function b64urlDecode(string $str): string
    {
        $rem = strlen($str) % 4;
        if ($rem > 0) {
            $str .= str_repeat('=', 4 - $rem);
        }
        return (string)base64_decode(strtr($str, '-_', '+/'), true);
    }

    public static function getRpId(): string
    {
        $host = (string)($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost');
        $host = preg_replace('/:\d+$/', '', strtolower(trim($host))) ?? 'localhost';
        return $host !== '' ? $host : 'localhost';
    }

    public static function getPasskeyRegisterOptions(array $user): array
    {
        Auth::startSession();
        $challenge = random_bytes(32);
        $_SESSION['webauthn_reg_challenge'] = self::b64urlEncode($challenge);
        $_SESSION['webauthn_reg_expires']   = time() + 300;

        $pdo = Database::get();
        $stmt = $pdo->prepare('SELECT credential_id FROM user_passkeys WHERE user_id = :uid');
        $stmt->execute([':uid' => (int)$user['id']]);
        $exclude = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $cid) {
            $exclude[] = ['type' => 'public-key', 'id' => (string)$cid];
        }

        $settings = Database::getSettings();
        return [
            'rpId'               => self::getRpId(),
            'rpName'             => $settings['app_name'] ?? 'PureCloud',
            'userIdB64'          => self::b64urlEncode(pack('N', (int)$user['id'])),
            'userName'           => $user['username'],
            'userDisplayName'    => $user['display_name'] ?: $user['username'],
            'challengeB64'       => $_SESSION['webauthn_reg_challenge'],
            'excludeCredentials' => $exclude,
        ];
    }

    public static function registerPasskey(int $userId, array $input): array
    {
        Auth::startSession();
        $expectedChallenge = (string)($_SESSION['webauthn_reg_challenge'] ?? '');
        $expiresAt         = (int)($_SESSION['webauthn_reg_expires'] ?? 0);
        unset($_SESSION['webauthn_reg_challenge'], $_SESSION['webauthn_reg_expires']);

        if ($expectedChallenge === '' || time() > $expiresAt) {
            throw new RuntimeException('Passkey-Registrierung abgelaufen. Bitte erneut versuchen.');
        }

        $credentialId  = trim((string)($input['credential_id'] ?? ''));
        $clientDataB64 = (string)($input['client_data_json'] ?? '');
        $authDataB64   = (string)($input['authenticator_data'] ?? '');
        $spkiDerB64    = (string)($input['public_key_spki'] ?? '');
        $coseAlg       = (int)($input['public_key_alg'] ?? -7);
        $deviceName    = trim((string)($input['device_name'] ?? '')) ?: ('Biometrie / Passkey (' . date('d.m.Y') . ')');
        $deviceName    = mb_substr($deviceName, 0, 100);

        $clientDataRaw = self::b64urlDecode($clientDataB64);
        $clientData    = json_decode($clientDataRaw, true);
        if (!is_array($clientData) || ($clientData['type'] ?? '') !== 'webauthn.create') {
            throw new RuntimeException('Ungültige WebAuthn-ClientData.');
        }
        if (!hash_equals($expectedChallenge, (string)($clientData['challenge'] ?? ''))) {
            throw new RuntimeException('Sicherheits-Challenge stimmt nicht überein.');
        }

        $rpId = self::getRpId();
        $originHost = strtolower((string)parse_url((string)($clientData['origin'] ?? ''), PHP_URL_HOST));
        if ($originHost !== '' && $originHost !== $rpId) {
            throw new RuntimeException('Ungültige Origin-Domain.');
        }

        $pem = null;
        if ($spkiDerB64 !== '') {
            $spkiDer = self::b64urlDecode($spkiDerB64);
            if ($spkiDer !== '') {
                $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spkiDer), 64, "\n") . "-----END PUBLIC KEY-----\n";
            }
        }
        if ($pem === null && $authDataB64 !== '') {
            $pem = self::extractP256PemFromAuthData(self::b64urlDecode($authDataB64));
        }

        if ($pem === null || @openssl_pkey_get_public($pem) === false) {
            throw new RuntimeException('Öffentlicher Schlüssel des Passkeys konnte nicht gelesen werden.');
        }

        $pdo = Database::get();
        $stmt = $pdo->prepare("
            INSERT INTO user_passkeys (user_id, credential_id, public_key_pem, cose_alg, device_name, created_at)
            VALUES (:uid, :cid, :pem, :alg, :dev, datetime('now'))
        ");
        $stmt->execute([
            ':uid' => $userId,
            ':cid' => $credentialId,
            ':pem' => $pem,
            ':alg' => $coseAlg,
            ':dev' => $deviceName,
        ]);

        return [
            'id'          => (int)$pdo->lastInsertId(),
            'device_name' => $deviceName,
        ];
    }

    private static function extractP256PemFromAuthData(string $authDataBin): ?string
    {
        if (strlen($authDataBin) < 55) {
            return null;
        }
        $flags = ord($authDataBin[32]);
        if (($flags & 0x40) === 0) {
            return null;
        }
        $credIdLen = unpack('n', substr($authDataBin, 53, 2))[1] ?? 0;
        $coseOffset = 55 + $credIdLen;
        if (strlen($authDataBin) < $coseOffset + 70) {
            return null;
        }
        $coseSlice = substr($authDataBin, $coseOffset);
        $posX = strpos($coseSlice, "\x21\x58\x20");
        $posY = strpos($coseSlice, "\x22\x58\x20");
        if ($posX === false || $posY === false) {
            return null;
        }
        $x = substr($coseSlice, $posX + 3, 32);
        $y = substr($coseSlice, $posY + 3, 32);
        if (strlen($x) !== 32 || strlen($y) !== 32) {
            return null;
        }
        $spkiPrefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d03010703420004');
        if ($spkiPrefix === false) {
            return null;
        }
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spkiPrefix . $x . $y), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    public static function listPasskeys(int $userId): array
    {
        $pdo = Database::get();
        $stmt = $pdo->prepare('SELECT id, device_name, created_at, last_used_at FROM user_passkeys WHERE user_id = :uid ORDER BY created_at DESC');
        $stmt->execute([':uid' => $userId]);
        return array_map(fn($r) => [
            'id'           => (int)$r['id'],
            'device_name'  => $r['device_name'],
            'created_at'   => $r['created_at'],
            'last_used_at' => $r['last_used_at'],
        ], $stmt->fetchAll());
    }

    public static function deletePasskey(int $userId, int $passkeyId): void
    {
        $pdo = Database::get();
        $pdo->prepare('DELETE FROM user_passkeys WHERE id = :id AND user_id = :uid')
            ->execute([':id' => $passkeyId, ':uid' => $userId]);
    }

    public static function getPasskeyLoginOptions(?int $forUserId = null, string $username = ''): array
    {
        Auth::startSession();
        $challenge = random_bytes(32);
        $_SESSION['webauthn_auth_challenge'] = self::b64urlEncode($challenge);
        $_SESSION['webauthn_auth_expires']   = time() + 300;

        $pdo = Database::get();
        $allow = [];

        if ($forUserId !== null && $forUserId > 0) {
            $stmt = $pdo->prepare('SELECT credential_id FROM user_passkeys WHERE user_id = :uid');
            $stmt->execute([':uid' => $forUserId]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $cid) {
                $allow[] = ['type' => 'public-key', 'id' => (string)$cid];
            }
        } elseif (trim($username) !== '') {
            $stmt = $pdo->prepare('
                SELECT pk.credential_id
                FROM user_passkeys pk
                JOIN users u ON u.id = pk.user_id
                WHERE u.username = :u COLLATE NOCASE AND u.is_active = 1
            ');
            $stmt->execute([':u' => trim($username)]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $cid) {
                $allow[] = ['type' => 'public-key', 'id' => (string)$cid];
            }
        }

        return [
            'rpId'             => self::getRpId(),
            'challengeB64'     => $_SESSION['webauthn_auth_challenge'],
            'allowCredentials' => $allow,
        ];
    }

    public static function verifyPasskeyLogin(array $input, ?int $expectedUserId = null): array
    {
        Auth::startSession();
        $expectedChallenge = (string)($_SESSION['webauthn_auth_challenge'] ?? '');
        $expiresAt         = (int)($_SESSION['webauthn_auth_expires'] ?? 0);
        unset($_SESSION['webauthn_auth_challenge'], $_SESSION['webauthn_auth_expires']);

        if ($expectedChallenge === '' || time() > $expiresAt) {
            throw new RuntimeException('Biometrie-Anfrage abgelaufen. Bitte erneut versuchen.');
        }

        $credentialId  = trim((string)($input['credential_id'] ?? ''));
        $clientDataB64 = (string)($input['client_data_json'] ?? '');
        $authDataB64   = (string)($input['authenticator_data'] ?? '');
        $signatureB64  = (string)($input['signature'] ?? '');

        if ($credentialId === '' || $clientDataB64 === '' || $authDataB64 === '' || $signatureB64 === '') {
            throw new RuntimeException('Unvollständige Passkey-Antwort.');
        }

        $clientDataRaw = self::b64urlDecode($clientDataB64);
        $authDataBin   = self::b64urlDecode($authDataB64);
        $signatureBin  = self::b64urlDecode($signatureB64);

        $clientData = json_decode($clientDataRaw, true);
        if (!is_array($clientData) || ($clientData['type'] ?? '') !== 'webauthn.get') {
            throw new RuntimeException('Ungültige WebAuthn-Antwort.');
        }
        if (!hash_equals($expectedChallenge, (string)($clientData['challenge'] ?? ''))) {
            throw new RuntimeException('Sicherheits-Challenge stimmt nicht überein.');
        }

        $rpId = self::getRpId();
        $originHost = strtolower((string)parse_url((string)($clientData['origin'] ?? ''), PHP_URL_HOST));
        if ($originHost !== '' && $originHost !== $rpId) {
            throw new RuntimeException('Domain-Konflikt (Origin).');
        }

        $pdo = Database::get();
        $stmt = $pdo->prepare('
            SELECT pk.id AS pk_id, pk.user_id, pk.public_key_pem, pk.sign_count, u.is_active
            FROM user_passkeys pk
            JOIN users u ON u.id = pk.user_id
            WHERE pk.credential_id = :cid
            LIMIT 1
        ');
        $stmt->execute([':cid' => $credentialId]);
        $row = $stmt->fetch();

        if (!$row || (int)$row['is_active'] !== 1) {
            throw new RuntimeException('Dieser Passkey ist keinem aktiven Konto zugeordnet.');
        }
        if ($expectedUserId !== null && (int)$row['user_id'] !== $expectedUserId) {
            throw new RuntimeException('Dieser Passkey gehört nicht zum angemeldeten Konto.');
        }

        if (strlen($authDataBin) < 37) {
            throw new RuntimeException('Ungültige Authenticator-Daten.');
        }
        $expectedRpHash = hash('sha256', $rpId, true);
        if (!hash_equals($expectedRpHash, substr($authDataBin, 0, 32))) {
            throw new RuntimeException('RP-ID stimmt nicht überein.');
        }
        if ((ord($authDataBin[32]) & 0x01) === 0) {
            throw new RuntimeException('Anwesenheitsprüfung (User Presence) fehlgeschlagen.');
        }

        $signedData = $authDataBin . hash('sha256', $clientDataRaw, true);
        $pubKey     = @openssl_pkey_get_public((string)$row['public_key_pem']);
        if ($pubKey === false || @openssl_verify($signedData, $signatureBin, $pubKey, OPENSSL_ALGO_SHA256) !== 1) {
            throw new RuntimeException('Kryptografische Biometrie-Signatur ungültig.');
        }

        $newSignCount = (int)(unpack('N', substr($authDataBin, 33, 4))[1] ?? 0);
        $storedCount  = (int)$row['sign_count'];
        $pdo->prepare("UPDATE user_passkeys SET last_used_at = datetime('now'), sign_count = :sc WHERE id = :id")
            ->execute([':sc' => max($storedCount, $newSignCount), ':id' => (int)$row['pk_id']]);

        $remember = isset($input['remember']) ? !empty($input['remember']) : null;
        return Auth::completeLoginForUserId((int)$row['user_id'], $remember);
    }
}
