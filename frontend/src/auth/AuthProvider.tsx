import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface AuthUser {
  sub: string;
  email: string | null;
  name: string | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  authDisabled: boolean;
  configured: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [configured, setConfigured] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await fetch("/api/auth/config").then((r) => r.json()).catch(() => ({}));
      setAuthDisabled(!!cfg.disabled);
      setConfigured(!!cfg.configured || !!cfg.disabled);
      const r = await fetch("/api/auth/me");
      if (r.ok) setUser(await r.json());
      else setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function signIn() {
    const next = window.location.pathname + window.location.search;
    window.location.href = `/api/auth/login?next=${encodeURIComponent(next)}`;
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }

  return <Ctx.Provider value={{ user, loading, authDisabled, configured, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading, configured, signIn } = useAuth();
  if (loading) {
    return <div className="h-full flex items-center justify-center text-muted text-sm">Loading…</div>;
  }
  if (!user) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-3 max-w-sm px-6">
          <div className="text-xl font-semibold">stim·explorer</div>
          <div className="text-sm text-muted">Sign in to upload and analyze .stim traces.</div>
          {configured ? (
            <button
              onClick={signIn}
              className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90"
            >Sign in with Microsoft</button>
          ) : (
            <div className="text-xs text-err">
              Azure SSO is not configured on the server.<br />
              Set <code className="mono">AZURE_TENANT_ID</code>, <code className="mono">AZURE_CLIENT_ID</code>, <code className="mono">AZURE_CLIENT_SECRET</code>.<br />
              Or set <code className="mono">STIM_APP_DISABLE_AUTH=1</code> for local dev.
            </div>
          )}
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
