<?php
declare(strict_types=1);

namespace Cloud;

use RuntimeException;

class CryptoVault
{
    public const MAGIC      = 'PCLOUDV1'; // 8 bytes
    public const SALT_LEN   = 16;
    public const IV_LEN     = 12;
    public const TAG_LEN    = 16;
    public const HEADER_LEN = 8 + self::SALT_LEN + self::IV_LEN + self::TAG_LEN; // 52 bytes
    public const ITERATIONS = 100000;
    public const CIPHER     = 'aes-256-gcm';

    public static function isEncryptedFile(string $filePath): bool
    {
        if (!is_file($filePath) || filesize($filePath) < self::HEADER_LEN) {
            return false;
        }
        $fp = fopen($filePath, 'rb');
        if (!$fp) {
            return false;
        }
        $magic = fread($fp, 8);
        fclose($fp);
        return $magic === self::MAGIC;
    }

    public static function encryptFileInPlace(string $filePath, string $password): int
    {
        if (strlen($password) < 4) {
            throw new RuntimeException('Das Tresor-Passwort muss mindestens 4 Zeichen lang sein.');
        }
        if (!is_file($filePath) || !is_readable($filePath)) {
            throw new RuntimeException('Datei nicht gefunden oder nicht lesbar.');
        }
        if (self::isEncryptedFile($filePath)) {
            throw new RuntimeException('Diese Datei ist bereits verschlüsselt.');
        }

        $plaintext = file_get_contents($filePath);
        if ($plaintext === false) {
            throw new RuntimeException('Fehler beim Lesen der Datei.');
        }

        $salt = random_bytes(self::SALT_LEN);
        $iv   = random_bytes(self::IV_LEN);
        $key  = hash_pbkdf2('sha256', $password, $salt, self::ITERATIONS, 32, true);
        $tag  = '';

        $ciphertext = openssl_encrypt(
            $plaintext,
            self::CIPHER,
            $key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
            self::MAGIC,
            self::TAG_LEN
        );

        unset($plaintext, $key);

        if ($ciphertext === false || strlen($tag) !== self::TAG_LEN) {
            throw new RuntimeException('Verschlüsselung fehlgeschlagen.');
        }

        $tmpFile = $filePath . '.enc_tmp';
        $payload = self::MAGIC . $salt . $iv . $tag . $ciphertext;
        unset($ciphertext);

        if (file_put_contents($tmpFile, $payload, LOCK_EX) === false) {
            @unlink($tmpFile);
            throw new RuntimeException('Verschlüsselte Datei konnte nicht geschrieben werden.');
        }

        $newSize = strlen($payload);
        unset($payload);

        if (!rename($tmpFile, $filePath)) {
            @unlink($tmpFile);
            throw new RuntimeException('Verschlüsselte Datei konnte nicht ersetzt werden.');
        }

        return $newSize;
    }

    public static function decryptToBytes(string $filePath, string $password): string
    {
        if (!is_file($filePath) || !is_readable($filePath)) {
            throw new RuntimeException('Datei nicht gefunden.');
        }
        $data = file_get_contents($filePath);
        if ($data === false || strlen($data) < self::HEADER_LEN) {
            throw new RuntimeException('Ungültige oder beschädigte Tresor-Datei.');
        }

        $magic = substr($data, 0, 8);
        if ($magic !== self::MAGIC) {
            throw new RuntimeException('Diese Datei ist nicht im Tresor-Format verschlüsselt.');
        }

        $salt       = substr($data, 8, self::SALT_LEN);
        $iv         = substr($data, 8 + self::SALT_LEN, self::IV_LEN);
        $tag        = substr($data, 8 + self::SALT_LEN + self::IV_LEN, self::TAG_LEN);
        $ciphertext = substr($data, self::HEADER_LEN);
        unset($data);

        $key = hash_pbkdf2('sha256', $password, $salt, self::ITERATIONS, 32, true);

        $plaintext = openssl_decrypt(
            $ciphertext,
            self::CIPHER,
            $key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
            self::MAGIC
        );

        unset($ciphertext, $key);

        if ($plaintext === false) {
            throw new RuntimeException('Falsches Tresor-Passwort oder manipulierte Datei.');
        }

        return $plaintext;
    }

    public static function decryptFileInPlace(string $filePath, string $password): int
    {
        $plaintext = self::decryptToBytes($filePath, $password);
        $tmpFile   = $filePath . '.dec_tmp';

        if (file_put_contents($tmpFile, $plaintext, LOCK_EX) === false) {
            @unlink($tmpFile);
            throw new RuntimeException('Entschlüsselte Datei konnte nicht gespeichert werden.');
        }

        $newSize = strlen($plaintext);
        unset($plaintext);

        if (!rename($tmpFile, $filePath)) {
            @unlink($tmpFile);
            throw new RuntimeException('Datei konnte nicht aktualisiert werden.');
        }

        return $newSize;
    }
}
