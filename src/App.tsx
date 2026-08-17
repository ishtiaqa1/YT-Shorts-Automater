import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Home from './pages/Home';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Editor from './pages/Editor';
import Settings from './pages/Settings';
import Billing from './pages/Billing';
import Diagnostics from './pages/Diagnostics';
import Calendar from './pages/Calendar';
import Admin from './pages/Admin';
import Templates from './pages/Templates';

function Protected({ children }: { children: ReactNode }) {
  const { token, loading } = useAuth();
  if (loading) return <div className="centered">Loading…</div>;
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/app"
        element={
          <Protected>
            <Dashboard />
          </Protected>
        }
      />
      <Route
        path="/app/project/:id"
        element={
          <Protected>
            <Editor />
          </Protected>
        }
      />
      <Route
        path="/app/settings"
        element={
          <Protected>
            <Settings />
          </Protected>
        }
      />
      <Route
        path="/app/billing"
        element={
          <Protected>
            <Billing />
          </Protected>
        }
      />
      <Route
        path="/app/diagnostics"
        element={
          <Protected>
            <Diagnostics />
          </Protected>
        }
      />
      <Route
        path="/app/calendar"
        element={
          <Protected>
            <Calendar />
          </Protected>
        }
      />
      <Route
        path="/app/admin"
        element={
          <Protected>
            <Admin />
          </Protected>
        }
      />
      <Route
        path="/app/templates"
        element={
          <Protected>
            <Templates />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
