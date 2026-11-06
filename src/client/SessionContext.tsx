import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchMe, logoutUser, type CurrentUser } from "./api.ts";

// State sesi minimal tanpa library (story 4): boot = fetchMe sekali; gerbang
// App membaca status untuk memilih render. Context diekspor agar state gerbang
// bisa di-stub di uji komponen tanpa deps test baru.

/** Status gerbang sesi — tiga state render kondisional, tanpa router. */
export type SessionStatus = "loading" | "unauthenticated" | "authenticated";

export type SessionState = {
  status: SessionStatus;
  user: CurrentUser | null;
  /** Ambil ulang /api/me dan set status sesuai hasilnya. */
  refresh: () => Promise<void>;
  /** Tanpa sesi → aktif; dipanggil AuthPage setelah register/login sukses. */
  setUser: (user: CurrentUser) => void;
  /** logoutUser lalu refresh state — kembali ke form login. */
  signOut: () => Promise<void>;
};

export const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUserState] = useState<CurrentUser | null>(null);
  // Boot hanya sekali — guard ref menahan dobel efek StrictMode di dev.
  const bootedRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const me = await fetchMe();
      setUserState(me);
      setStatus("authenticated");
    } catch {
      // 401 (tanpa sesi) maupun kegagalan jaringan sama-sama berarti sesi
      // tidak bisa diverifikasi → tampilkan form.
      setUserState(null);
      setStatus("unauthenticated");
    }
  }, []);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void refresh();
  }, [refresh]);

  const setUser = useCallback((next: CurrentUser): void => {
    setUserState(next);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await logoutUser();
    await refresh();
  }, [refresh]);

  const value = useMemo<SessionState>(
    () => ({ status, user, refresh, setUser, signOut }),
    [status, user, refresh, setUser, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return context;
}
