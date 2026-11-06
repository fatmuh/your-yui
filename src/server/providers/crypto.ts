import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AD-3 — aliran kredensial BYOK. Modul ini satu-satunya tempat enkripsi,
// dekripsi, dan masking kredensial penyedia. KEK hanya dari env
// `APP_ENCRYPTION_KEY` (32 byte, base64 atau hex) — tanpa fallback dev,
// fail-fast saat dipakai. Format at-rest: `iv:tag:ct` (tiga segmen base64
// dipisah ':') disimpan sebagai BLOB — segmen base64 tak memuat ':' sehingga
// parsing tak ambigu.

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** KEK terdekripsi — hanya hidup di stack pemanggil, tak pernah di-export. */
export type EncryptionKey = {
  /** Brand tipis agar material tak bisa dibangun sembarangan dari string. */
  readonly __key: unique symbol;
  readonly bytes: Buffer;
};

/** Error konvensi service: kode stabil untuk dipetakan route ke envelope. */
export class CryptoError extends Error {
  readonly code: "encryption_key_unavailable" | "ciphertext_corrupt";

  constructor(code: CryptoError["code"], message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

function decodeKey(raw: string): Buffer {
  // Base64 kanonik (case-sensitive); hex diterima kedua kapitalisasi.
  const base64 = Buffer.from(raw, "base64");
  if (base64.length === KEY_BYTES && base64.toString("base64") === raw) {
    return base64;
  }
  const hex = Buffer.from(raw, "hex");
  if (hex.length === KEY_BYTES && (hex.toString("hex") === raw || hex.toString("hex") === raw.toLowerCase())) {
    return hex;
  }
  throw new CryptoError(
    "encryption_key_unavailable",
    "APP_ENCRYPTION_KEY must be a base64 or hex string that decodes to exactly 32 bytes (AES-256).",
  );
}

/**
 * KEK dari env `APP_ENCRYPTION_KEY` — fail-fast bila absen/invalid, TANPA
 * fallback dev (AD-3). Dibaca saat dipakai, bukan saat import, agar tes dan
 * tools yang tak menyentuh kredensial tetap jalan tanpa env.
 */
export function loadEncryptionKey(): EncryptionKey {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CryptoError(
      "encryption_key_unavailable",
      "APP_ENCRYPTION_KEY is not set. Provider credentials cannot be encrypted or decrypted without it; refusing to fall back to an insecure default.",
    );
  }
  return { __key: Symbol() as EncryptionKey["__key"], bytes: decodeKey(raw) };
}

/** Enkripsi AES-256-GCM → BLOB `iv:tag:ct` (segmen base64). */
export function encryptSecret(key: EncryptionKey, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new CryptoError("ciphertext_corrupt", "Unexpected GCM auth tag length.");
  }
  return Buffer.from(
    `${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`,
    "utf8",
  );
}

/** Dekripsi BLOB `iv:tag:ct`; throw `ciphertext_corrupt` bila tag tak cocok. */
export function decryptSecret(key: EncryptionKey, blob: Buffer): string {
  const parts = blob.toString("utf8").split(":");
  if (parts.length !== 3) {
    throw new CryptoError("ciphertext_corrupt", "Stored credential is not in iv:tag:ct format.");
  }
  const [ivRaw, tagRaw, ctRaw] = parts;
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivRaw, "base64");
    tag = Buffer.from(tagRaw, "base64");
    ciphertext = Buffer.from(ctRaw, "base64");
  } catch {
    throw new CryptoError("ciphertext_corrupt", "Stored credential segments are not valid base64.");
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError("ciphertext_corrupt", "Stored credential has unexpected segment sizes.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CryptoError(
      "ciphertext_corrupt",
      "Stored credential failed AES-256-GCM authentication (wrong key or tampered data).",
    );
  }
}

/**
 * Bentuk mask kredensial untuk log/error/respons: `sk-…abcd` — prefiks 3
 * karakter pertama + elipsis + 4 karakter terakhir. Kredensial pendek
 * (< 12 karakter) dimask penuh tanpa fragmen agar tak bisa direkonstruksi.
 */
export function maskSecret(secret: string): string {
  if (secret.length < 12) {
    return "…";
  }
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}
