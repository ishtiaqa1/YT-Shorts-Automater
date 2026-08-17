import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, getToken } from './api';

export type User = {
  id: string;
  email: string;
  display_name: string | null;
  plan: string;
  timezone?: string;
  onboarding_completed?: boolean;
  referral_code?: string | null;
  subscription_ends_at?: string | null;
};

type AuthState = {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, display_name?: string, referral_from?: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      setLoading(false);
      return;
    }
    setToken(t);
    api<{ user: User }>('/api/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => {
        localStorage.removeItem('token');
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem('token', data.token);
    setToken(data.token);
    setUser(data.user);
  }, []);

  const register = useCallback(
    async (email: string, password: string, display_name?: string, referral_from?: string) => {
      const body: Record<string, unknown> = { email, password, display_name };
      if (referral_from?.trim()) body.referral_from = referral_from.trim().toUpperCase();
      const data = await api<{ token: string; user: User }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
    },
    []
  );

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    const t = getToken();
    if (!t) return;
    const d = await api<{ user: User }>('/api/auth/me');
    setUser(d.user);
  }, []);

  /** Other tabs bump `shorts_tz_bump` after saving timezone; tab focus also re-syncs `/me`. */
  useEffect(() => {
    let visTimer: ReturnType<typeof setTimeout> | undefined;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'shorts_tz_bump') return;
      void refreshUser();
    };
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(visTimer);
      visTimer = setTimeout(() => {
        void refreshUser();
      }, 400);
    };
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(visTimer);
    };
  }, [refreshUser]);

  const value = useMemo(
    () => ({
      user,
      token,
      loading,
      login,
      register,
      logout,
      refreshUser,
    }),
    [user, token, loading, login, register, logout, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside provider');
  return ctx;
}
