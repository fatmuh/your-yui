import { useState, type FormEvent } from "react";
import { ApiError, loginUser, registerUser } from "./api.ts";
import { useSession } from "./SessionContext.tsx";

// Form auth dua-mode (story 4): sign in / create account, teks UI English.
// Submit memanggil Auth API story 3 apa adanya; pesan error berasal dari
// envelope (ApiError.message) — tanpa dump JSON mentah.

export type AuthMode = "signin" | "register";

export type AuthPageProps = {
  /** Pesan error awal yang dirender form (stub uji komponen / pemanggil gerbang). */
  initialError?: string | null;
  /** Mode awal form; default sign-in, toggle di-handle internal. */
  initialMode?: AuthMode;
};

/** Error non-ApiError (mis. jaringan mati) — tidak membocorkan detail internal. */
const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

export default function AuthPage({
  initialError = null,
  initialMode = "signin",
}: AuthPageProps) {
  const { setUser } = useSession();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [error, setError] = useState<string | null>(initialError);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  const isRegister = mode === "register";

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const user = isRegister
        ? await registerUser(username, password)
        : await loginUser(username, password);
      setUser(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : GENERIC_ERROR_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  function toggleMode(): void {
    setMode((current) => (current === "signin" ? "register" : "signin"));
    setError(null);
    setPassword("");
  }

  return (
    <section className="auth-card" aria-labelledby="auth-heading">
      <h2 id="auth-heading">{isRegister ? "Create account" : "Sign in to Yui"}</h2>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="form-field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <button type="submit" className="button-primary" disabled={pending}>
          {isRegister ? "Create account" : "Sign in"}
        </button>
      </form>
      <button type="button" className="button-link" onClick={toggleMode}>
        {isRegister ? "Back to sign in" : "Create account"}
      </button>
    </section>
  );
}
