import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, MessagesSquare, Users, CheckSquare, ClipboardList, BarChart2, LogOut, UploadCloud, Briefcase, Zap, FileText, AppWindow, CalendarCheck, Calculator, CalendarDays } from 'lucide-react';
import { USERS, CURRENT_USER_ID, mockService } from '../services/mockData';
import { Role } from '../types';
import { fetchChatContacts } from '../services/chatCoreApi';
import { fetchInternalConversations } from '../services/internalChatApi';

const APP_NAME = String(import.meta.env.VITE_APP_NAME || 'WA PRO').trim() || 'WA PRO';
const DEFAULT_LOGO_URL = '/Logo.png';
const APP_LOGO_URL = String(import.meta.env.VITE_APP_LOGO_URL || DEFAULT_LOGO_URL).trim() || DEFAULT_LOGO_URL;

function buildUnreadOverlayDataUrl(total: number): string {
  const safeTotal = Math.max(0, Number(total) || 0);
  if (safeTotal <= 0 || typeof document === 'undefined') return '';

  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const text = safeTotal > 99 ? '99+' : String(safeTotal);
  const fontSize = text.length >= 3 ? 26 : text.length === 2 ? 30 : 34;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e11d48';
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${fontSize}px Segoe UI, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);

  return canvas.toDataURL('image/png');
}

function appInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'WA';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [logoFailed, setLogoFailed] = useState(false);
  const [inboxUnreadTotal, setInboxUnreadTotal] = useState(0);
  const [internalUnreadTotal, setInternalUnreadTotal] = useState(0);
  const logoCandidates = useMemo(() => Array.from(new Set([APP_LOGO_URL, '/Logo.png', '/logo.png'])), []);
  const [logoAttempt, setLogoAttempt] = useState(0);
  const logoSrc = logoCandidates[Math.min(logoAttempt, logoCandidates.length - 1)];

  const currentUser = mockService.getCurrentUser() || USERS.find(u => u.id === CURRENT_USER_ID);
  const isAdmin = currentUser?.role === Role.ADMIN;
  const currentUserId = String(mockService.getCurrentUserId() || CURRENT_USER_ID || '').trim();

  const navItems = [
    { path: '/inbox', label: 'WhatsApp', icon: MessageSquare },
    { path: '/internal-chat', label: 'Chat Interno', icon: MessagesSquare },
    { path: '/agenda', label: 'Agenda', icon: CalendarDays },
    { path: '/tasks', label: 'Tarefas', icon: CheckSquare },
    { path: '/occurrences', label: 'Ocorrências', icon: ClipboardList },
    { path: '/customers', label: 'Clientes', icon: Users },
    { path: '/employees', label: 'Funcionários', icon: Briefcase },
    { path: '/pedidos', label: 'Pedidos', icon: CalendarCheck },
    { path: '/software', label: 'Software', icon: AppWindow },
    { path: '/simulators', label: 'Simuladores', icon: Calculator },
    { path: '/automation', label: 'Automação', icon: Zap, adminOnly: true },
    { path: '/response-forms', label: 'Formulários', icon: FileText, adminOnly: true },
    { path: '/reports', label: 'Relatórios', icon: BarChart2, adminOnly: true },
    { path: '/import', label: 'Importar', icon: UploadCloud, adminOnly: true },
  ];
  // Versão curta dos labels para ecrãs ≤1600px
  const shortLabels: Record<string, string> = {
    'Chat Interno': 'Chat Int.',
    'Ocorrências': 'Ocorr.',
    'Funcionários': 'Funcio.',
    'Simuladores': 'Simul.',
    'Formulários': 'Forms',
    'Relatórios': 'Relat.',
    'Importar': 'Import.',
  };

  const visibleNavItems = navItems.filter((item) => !item.adminOnly || isAdmin);

  const handleLogout = () => {
    mockService.logoutUser();
    navigate('/login', { replace: true });
  };

  useEffect(() => {
    let isCancelled = false;

    const loadUnreadBadges = async () => {
      try {
        const contacts = await fetchChatContacts();
        const inboxTotal = (Array.isArray(contacts) ? contacts : []).reduce(
          (sum, item) => sum + Math.max(0, Number(item?.unread_count || 0)),
          0
        );
        if (!isCancelled) {
          setInboxUnreadTotal(inboxTotal);
        }
      } catch (_) {
        if (!isCancelled) {
          setInboxUnreadTotal(0);
        }
      }

      if (!currentUserId) {
        if (!isCancelled) {
          setInternalUnreadTotal(0);
        }
        return;
      }

      try {
        const conversations = await fetchInternalConversations(currentUserId);
        const internalTotal = (Array.isArray(conversations) ? conversations : []).reduce(
          (sum, item) => sum + Math.max(0, Number(item?.unreadCount || 0)),
          0
        );
        if (!isCancelled) {
          setInternalUnreadTotal(internalTotal);
        }
      } catch (_) {
        if (!isCancelled) {
          setInternalUnreadTotal(0);
        }
      }
    };

    void loadUnreadBadges();
    const timer = window.setInterval(() => {
      void loadUnreadBadges();
    }, 8000);

    return () => {
      isCancelled = true;
      window.clearInterval(timer);
    };
  }, [currentUserId]);

  useEffect(() => {
    const total = Math.max(0, inboxUnreadTotal + internalUnreadTotal);
    document.title = total > 0 ? `(${total}) ${APP_NAME}` : APP_NAME;
    try {
      (window as any)?.waDesktop?.setUnreadCount?.(total);
      const overlayDataUrl = total > 0 ? buildUnreadOverlayDataUrl(total) : '';
      (window as any)?.waDesktop?.setUnreadOverlay?.(total, overlayDataUrl);
    } catch (_) {
      // ignore
    }
  }, [inboxUnreadTotal, internalUnreadTotal]);

  return (
    <div className="h-screen bg-gray-100 overflow-hidden flex flex-col">
      <header className="bg-white border-b border-gray-200 shrink-0">
        <div className="h-14 px-2 md:px-4 flex items-center gap-2 md:gap-4">
          <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1 shadow-sm shrink-0">
            <div className="h-8 w-20 md:w-24 rounded-lg border border-slate-200 bg-white overflow-hidden flex items-center justify-center">
              {!logoFailed ? (
                <img
                  src={logoSrc}
                  alt={`${APP_NAME} Logo`}
                  className="h-full w-full object-contain p-1"
                  onError={() => {
                    if (logoAttempt < logoCandidates.length - 1) {
                      setLogoAttempt((prev) => prev + 1);
                      return;
                    }
                    setLogoFailed(true);
                  }}
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-whatsapp-700 text-xs font-bold">
                  {appInitials(APP_NAME)}
                </div>
              )}
            </div>
            <span className="text-whatsapp-700 font-semibold text-base leading-none">{APP_NAME}</span>
          </div>

          <nav className="flex-1 overflow-x-auto scrollbar-hide">
            <div className="flex items-center gap-0.5 min-w-max">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname.startsWith(item.path);
                const badgeValue =
                  item.path === '/inbox'
                    ? inboxUnreadTotal
                    : item.path === '/internal-chat'
                      ? internalUnreadTotal
                      : 0;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    title={item.label}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[12px] font-medium transition-colors whitespace-nowrap ${
                      isActive
                        ? 'bg-whatsapp-50 text-whatsapp-700'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                  >
                    <Icon size={14} />
                    <span className="hidden xl:inline">{item.label}</span>
                    <span className="xl:hidden">{shortLabels[item.label] ?? item.label}</span>
                    {badgeValue > 0 && (
                      <span className="ml-0.5 min-w-[17px] h-[17px] px-1 rounded-full bg-rose-600 text-white text-[10px] leading-[17px] text-center font-semibold">
                        {badgeValue > 99 ? '99+' : badgeValue}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </nav>

          <div className="flex items-center gap-2 min-w-0 shrink-0">
            <img
              src={currentUser?.avatarUrl}
              alt={currentUser?.name}
              className="w-8 h-8 rounded-full bg-gray-200 object-cover shrink-0"
            />
            <div className="hidden lg:block min-w-0 max-w-[120px]">
              <p className="text-xs font-medium text-gray-900 truncate">{currentUser?.name}</p>
              <p className="text-[10px] text-gray-500 truncate">{currentUser?.role}</p>
            </div>
            <button
              onClick={handleLogout}
              className="text-gray-400 hover:text-gray-600 p-1.5"
              title="Terminar sessão"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
};

export default Layout;
