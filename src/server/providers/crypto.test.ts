import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  loadEncryptionKey,
  maskSecret,
} from "./crypto.ts";

// AD-3: round-trip GCM, format iv:tag:ct, mask `sk-…abcd`, KEK fail-fast.

const KEY_B64 = randomBytes(32).toString("base64");

function withKey<T>(fn: () => T): T {
  const prev = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = KEY_B64;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = prev;
    }
  }
}

afterEach(() => {
  delete process.env.APP_ENCRYPTION_KEY;
});

describe("loadEncryptionKey", () => {
  it("menerima KEK base64 32 byte", () => {
    const key = withKey(() => loadEncryptionKey());
    expect(key.bytes.length).toBe(32);
  });

  it("menerima KEK hex 32 byte (kedua kapitalisasi)", () => {
    const hex = randomBytes(32).toString("hex");
    process.env.APP_ENCRYPTION_KEY = hex;
    expect(loadEncryptionKey().bytes.toString("hex")).toBe(hex);
    process.env.APP_ENCRYPTION_KEY = hex.toUpperCase();
    expect(loadEncryptionKey().bytes.toString("hex")).toBe(hex);
  });

  it("absen: fail-fast dengan pesan jelas, tanpa fallback (matriks KEK absen)", () => {
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => loadEncryptionKey()).toThrowError(CryptoError);
    expect(() => loadEncryptionKey()).toThrowError(/APP_ENCRYPTION_KEY is not set/);
  });

  it("bukan 32 byte: ditolak dengan pesan jelas", () => {
    process.env.APP_ENCRYPTION_KEY = "terlalu-pendek";
    expect(() => loadEncryptionKey()).toThrowError(/exactly 32 bytes/);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trip: plaintext kembali utuh", () => {
    const secret = "sk-live-abcdefgh1234567890";
    expect(withKey(() => decryptSecret(loadEncryptionKey(), encryptSecret(loadEncryptionKey(), secret)))).toBe(secret);
  });

  it("format at-rest iv:tag:ct tiga segmen base64; ciphertext tak memuat plaintext", () => {
    const secret = "sk-live-abcdefgh1234567890";
    const blob = withKey(() => encryptSecret(loadEncryptionKey(), secret));
    const text = blob.toString("utf8");
    const segments = text.split(":");
    expect(segments).toHaveLength(3);
    expect(text).not.toContain(secret);
    // IV 12 byte, tag 16 byte setelah decode base64.
    expect(Buffer.from(segments[0], "base64").length).toBe(12);
    expect(Buffer.from(segments[1], "base64").length).toBe(16);
  });

  it("IV acak per enkripsi: dua blob atas plaintext sama berbeda", () => {
    const blobs = [0, 1].map(() =>
      withKey(() => encryptSecret(loadEncryptionKey(), "sk-live-same-secret-value")),
    );
    expect(blobs[0].toString("utf8")).not.toBe(blobs[1].toString("utf8"));
  });

  it("KEK salah / blob diubah: gagal autentikasi GCM, bukan plaintext bocor", () => {
    const secret = "sk-live-abcdefgh1234567890";
    const blob = withKey(() => encryptSecret(loadEncryptionKey(), secret));

    // Kunci valid tapi BERBEDA: GCM menolak.
    const wrongKeyB64 = randomBytes(32).toString("base64");
    expect(wrongKeyB64).not.toBe(KEY_B64);
    process.env.APP_ENCRYPTION_KEY = wrongKeyB64;
    expect(() => decryptSecret(loadEncryptionKey(), blob)).toThrowError(CryptoError);

    // Kunci benar tapi blob diubah: GCM menolak.
    process.env.APP_ENCRYPTION_KEY = KEY_B64;
    const tampered = Buffer.from(blob.toString("utf8").slice(0, -4) + "AAAA", "utf8");
    expect(() => decryptSecret(loadEncryptionKey(), tampered)).toThrowError(CryptoError);
    expect(tampered.toString("utf8")).not.toContain(secret);
  });
});

describe("maskSecret", () => {
  it("bentuk `sk-…abcd`: prefiks 3 + elipsis + 4 terakhir", () => {
    expect(maskSecret("sk-proj-abcdefghijklmn")).toBe("sk-…klmn");
    expect(maskSecret("sk-verylongcredentialkey9999")).toBe("sk-…9999");
  });

  it("kredensial pendek dimask penuh — tak ada fragmen yang bocor", () => {
    expect(maskSecret("short")).toBe("…");
    expect(maskSecret("")).toBe("…");
    expect(maskSecret("12345678901")).toBe("…");
  });

  it("panjang 12: masih menampilkan fragmen (batas)", () => {
    expect(maskSecret("abcdefghijkl")).toBe("abc…ijkl");
  });
});
