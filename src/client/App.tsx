import { APP_NAME } from "../shared/app.ts";
import AuthPage from "./AuthPage.tsx";
import { SessionProvider, useSession } from "./SessionContext.tsx";
import TemplateApp from "./TemplateApp.tsx";

// Gerbang sesi (story 4): tiga state render kondisional tanpa router —
// loading → AuthPage → aplikasi template (story 3.1). Aplikasi template
// membawa app-shell layar-penuhnya sendiri (h-dvh), jadi state authenticated
// merender root template apa adanya; dua state lain tetap pada shell minimal
// fondasi dengan heading "Yui" (R3).
// SessionGate diekspor terpisah agar uji komponen bisa meng-stub state sesi.

export function SessionGate() {
  const { status } = useSession();

  if (status === "authenticated") return <TemplateApp />;

  return (
    <main className="gate-shell">
      <h1>{APP_NAME}</h1>
      {status === "loading" && <p>Loading…</p>}
      {status === "unauthenticated" && <AuthPage />}
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
