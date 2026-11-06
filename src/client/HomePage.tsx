import { useState } from "react";
import { useSession } from "./SessionContext.tsx";

// Halaman terlindungi (story 4): bukti ujung-ke-ujung bahwa sesi bekerja.
// createdAt ISO-8601 UTC hanya ada bila user berasal dari /api/me (boot);
// hasil register/login langsung {id, username} — info sesi menyusul di boot
// berikutnya.

export default function HomePage() {
  const { user, signOut } = useSession();
  const [pending, setPending] = useState(false);

  if (user === null) return null;

  async function handleSignOut(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await signOut();
    } catch {
      // Gagal mencabut sesi (mis. jaringan) — sesi masih hidup, tetap di
      // halaman; refresh berikutnya yang menentukan state. Tanpa surface error.
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="auth-card">
      <p>
        Signed in as <strong>{user.username}</strong>
      </p>
      {user.createdAt !== undefined && (
        <p className="session-info">Account created {user.createdAt}</p>
      )}
      <button
        type="button"
        className="button-primary"
        disabled={pending}
        onClick={() => void handleSignOut()}
      >
        Sign out
      </button>
    </section>
  );
}
