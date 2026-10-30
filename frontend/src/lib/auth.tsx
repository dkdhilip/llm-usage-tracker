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
import {
  api,
  isConnectionProblem,
  setSessionExpiredHandler,
  type AuthUser,
  type WorkspaceRef,
  type WorkspaceRole,
} from "./api";

interface AuthCtx {
  user: AuthUser | null;
  authenticated: boolean;
  workspace: WorkspaceRef | null;
  role: WorkspaceRole | null;
  inWorkspace: boolean;
  isWorkspaceAdmin: boolean;
  loading: boolean;
  /** True once a signed-in user's session was found to be expired (cleared by the next sign-in or sign-out). */
  sessionExpired: boolean;
  login: (username: string, password: string) => Promise<void>;
  signup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** The server could not be reached (or is failing) while checking the session. The visitor is NOT treated as
   *  signed out: the app says so and offers a retry instead of showing the sign-in form. */
  connectionError: boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const userRef = useRef<AuthUser | null>(null);
  userRef.current = user;

  // api.ts reports a 401 from the session-authenticated API here. Dropping `user` is all it takes: the existing
  // RequireAuth / RequireWorkspace wrappers already redirect an unauthenticated visitor to /login.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      if (userRef.current) setSessionExpired(true); // only a signed-in user can have an expired session
      setUser(null);
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me.authenticated ? me.user : null);
      setConnectionError(false);
    } catch (e) {
      // A dead network or a failing server says nothing about the session, so keep whoever is signed in.
      if (isConnectionProblem(e)) setConnectionError(true);
      else setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    setUser((await api.login(username, password)).user);
    setSessionExpired(false);
  }, []);

  const signup = useCallback(async (username: string, password: string) => {
    setUser((await api.signup(username, password)).user);
    setSessionExpired(false);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setSessionExpired(false);
  }, []);

  const value = useMemo<AuthCtx>(() => {
    const workspace = user?.workspace ?? null;
    return {
      user,
      authenticated: user !== null,
      workspace,
      role: workspace?.role ?? null,
      inWorkspace: workspace !== null,
      isWorkspaceAdmin: workspace?.role === "admin",
      loading,
      sessionExpired,
      connectionError,
      login,
      signup,
      logout,
      refresh,
    };
  }, [user, loading, sessionExpired, connectionError, login, signup, logout, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used within <AuthProvider>");
  return v;
}
