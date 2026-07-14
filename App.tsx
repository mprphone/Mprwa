import React, { Suspense, lazy, useEffect, useState } from 'react';
import { HashRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import Login from './pages/Login';
import { mockService } from './services/mockData';

// Páginas carregadas sob demanda (code-splitting). Cada rota vira um chunk
// próprio, pelo que o arranque só descarrega a página realmente aberta.
const Inbox = lazy(() => import('./pages/Inbox'));
const InternalChat = lazy(() => import('./pages/InternalChat'));
const Agenda = lazy(() => import('./pages/Agenda'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Occurrences = lazy(() => import('./pages/Occurrences'));
const Customers = lazy(() => import('./pages/Customers'));
const Employees = lazy(() => import('./pages/Employees'));
const Pedidos = lazy(() => import('./pages/Pedidos'));
const Reports = lazy(() => import('./pages/Reports'));
const CallImport = lazy(() => import('./pages/CallImport'));
const AutoResponses = lazy(() => import('./pages/AutoResponses'));
const ResponseForms = lazy(() => import('./pages/ResponseForms'));
const SoftwareHub = lazy(() => import('./pages/SoftwareHub'));
const Simulators = lazy(() => import('./pages/Simulators'));
const MobileWorkspace = lazy(() => import('./pages/MobileWorkspace'));

const RouteFallback: React.FC = () => (
  <div className="flex h-full w-full items-center justify-center p-8 text-gray-400">
    <span className="animate-pulse text-sm">A carregar…</span>
  </div>
);

function isStandaloneMobileShell(): boolean {
  if (typeof window === 'undefined') return false;
  const navigatorStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
  return navigatorStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

const ProtectedApp: React.FC = () => {
  const location = useLocation();
  const [isCompactViewport, setIsCompactViewport] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setIsCompactViewport(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  if (!mockService.isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  if (isStandaloneMobileShell() && !location.pathname.startsWith('/mobile')) {
    return <Navigate to="/mobile/chat" replace />;
  }

  if (location.pathname.startsWith('/mobile')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/mobile/*" element={<MobileWorkspace />} />
          <Route path="*" element={<Navigate to="/mobile/chat" replace />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Layout>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to={isCompactViewport ? '/mobile/chat' : '/inbox'} replace />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/internal-chat" element={<InternalChat />} />
          <Route path="/agenda" element={<Agenda />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/occurrences" element={<Occurrences />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/employees" element={<Employees />} />
          <Route path="/pedidos" element={<Pedidos />} />
          <Route path="/software" element={<SoftwareHub />} />
          <Route path="/simulators" element={<Simulators />} />
          <Route path="/automation" element={<AutoResponses />} />
          <Route path="/response-forms" element={<ResponseForms />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/import" element={<CallImport />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
};

const App: React.FC = () => {
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let active = true;
    void mockService.initializeAuthSession().finally(() => {
      if (active) setAuthReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!authReady) {
    return (
      <div className="min-h-screen bg-gray-100">
        <RouteFallback />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<ProtectedApp />} />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
};

export default App;
