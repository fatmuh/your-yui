import { APP_NAME } from "../shared/app.ts";
import AuthPage from "./AuthPage.tsx";
import HomePage from "./HomePage.tsx";
import { SessionProvider, useSession } from "./SessionContext.tsx";

// Gerbang sesi (story 4): tiga state render kondisional tanpa router —
// loading → AuthPage → HomePage. Heading "Yui" selalu tampil (R3).
// SessionGate diekspor terpisah agar uji komponen bisa meng-stub state sesi.

export function SessionGate() {
  const { status } = useSession();

  return (
    <main>
      <h1>{APP_NAME}</h1>
      {status === "loading" && <p>Loading…</p>}
      {status === "unauthenticated" && <AuthPage />}
      {status === "authenticated" && <HomePage />}
    </main>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <SessionGate />
    </SessionProvider>
  );
}
