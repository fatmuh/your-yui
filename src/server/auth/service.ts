import { createHash, randomBytes } from "node:crypto";
import { hash as argon2Hash, hashSync, verify as argon2Verify } from "@node-rs/argon2";
import { and, eq, gt } from "drizzle-orm";
import { ulid } from "ulidx";
import { authSessions, users } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";
import type { UserDto } from "../../shared/app.ts";

// Service auth (AD-9): hash/verify argon2 + siklus hidup sesi token — tanpa HTTP.
// Pola post-Lucia: token mentah hanya keluar sekali ke cookie; DB menyimpan
// sha256(token) sehingga kebocoran DB tidak memungkinkan pemalsuan sesi.

/** Username valid pasca-normalisasi (lowercase+trim sudah diterapkan). */
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;

const MIN_PASSWORD_LENGTH = 8;

/** 30 hari dalam epoch-ms — umur sesi (matriks story 3). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Error code yang dipetakan route ke status HTTP + envelope `{error:{code,message}}`. */
export type AuthErrorCode =
  | "invalid_request"
  | "username_taken"
  | "invalid_credentials"
  | "unauthorized";

/** Hash sekali saat module load untuk verifikasi dummy anti user-enumeration timing. */
const DUMMY_HASH = hashSync("yui-timing-equalizer");

// Catatan: tanpa parameter-property constructor — syntax itu tidak "erasable"
// sehingga mode type-stripping Node (jalannya server di produksi) menolaknya.
// Pesan user-facing didefinisikan satu tempat di routes (pemilik envelope).
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Bagian user yang boleh keluar API — `passwordHash` tidak pernah ikut. Turunan kontrak shared (AD-8). */
export type PublicUser = Pick<UserDto, "id" | "username">;

export type SessionUser = PublicUser & { createdAt: number };

/** Input mentah dari body JSON — service yang memvalidasi bentuknya. */
export type CredentialsInput = { username: unknown; password: unknown };

function sha256Hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Lowercase + trim; null bila bukan string. */
function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Buat sesi baru: token acak 32 byte (base64url), disimpan sebagai sha256 hex
 * dengan `expires_at` 30 hari. Mengembalikan token mentah SATU KALI — pemanggil
 * (route) menaruhnya di cookie httpOnly lalu membuangnya.
 */
export function createSession(db: YuiDatabase, userId: string): { token: string } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.insert(authSessions)
    .values({
      id: ulid(),
      userId,
      tokenHash: sha256Hex(token),
      expiresAt: now + SESSION_TTL_MS,
      createdAt: now,
    })
    .run();
  return { token };
}

/** User pemilik sesi token, atau null bila token tak dikenal/kadaluarsa. */
export function sessionUser(db: YuiDatabase, token: string): SessionUser | null {
  const row = db
    .select({ id: users.id, username: users.username, createdAt: users.createdAt })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        eq(authSessions.tokenHash, sha256Hex(token)),
        gt(authSessions.expiresAt, Date.now()),
      ),
    )
    .get();
  return row ?? null;
}

/** Cabut satu sesi (logout) — scope per token, sesi lain milik user tetap hidup. */
export function deleteSession(db: YuiDatabase, token: string): void {
  db.delete(authSessions).where(eq(authSessions.tokenHash, sha256Hex(token))).run();
}

/**
 * Daftar akun: normalisasi, validasi, cek bentrok, hash, insert `users`,
 * lalu langsung buat sesi. `username_taken` juga menangkap race INSERT
 * (UNIQUE constraint) antara dua register bersamaan.
 */
export async function registerUser(
  db: YuiDatabase,
  input: CredentialsInput,
): Promise<{ user: PublicUser; token: string }> {
  const username = normalizeUsername(input.username);
  const password = input.password;

  if (
    username === null ||
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH
  ) {
    throw new AuthError("invalid_request");
  }

  const existing = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .get();
  if (existing) {
    throw new AuthError("username_taken");
  }

  const now = Date.now();
  const id = ulid();
  const passwordHash = await argon2Hash(password);

  try {
    db.insert(users)
      .values({ id, username, passwordHash, createdAt: now, updatedAt: now })
      .run();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: users.username")
    ) {
      throw new AuthError("username_taken");
    }
    throw error;
  }

  const session = createSession(db, id);
  return { user: { id, username }, token: session.token };
}

/**
 * Masuk: cari user by username ter-normalisasi, verify argon2, buat sesi.
 * Anti user-enumeration: user tak dikenal tetap menjalani `argon2Verify`
 * terhadap DUMMY_HASH agar durasi respons ≈ login sungguhan, dan kode+pesan
 * identik dengan password salah.
 */
export async function loginUser(
  db: YuiDatabase,
  input: CredentialsInput,
): Promise<{ user: PublicUser; token: string }> {
  const username = normalizeUsername(input.username);
  const password = typeof input.password === "string" ? input.password : "";

  const row =
    username === null
      ? undefined
      : db
          .select()
          .from(users)
          .where(eq(users.username, username))
          .get();

  if (row === undefined) {
    await argon2Verify(DUMMY_HASH, password);
    throw new AuthError("invalid_credentials");
  }

  const verified = await argon2Verify(row.passwordHash, password);
  if (!verified) {
    throw new AuthError("invalid_credentials");
  }

  const session = createSession(db, row.id);
  return { user: { id: row.id, username: row.username }, token: session.token };
}
