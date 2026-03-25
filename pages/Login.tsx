import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Mail } from 'lucide-react';
import { mockService } from '../services/mockData';

const APP_NAME = String(import.meta.env.VITE_APP_NAME || 'WA PRO').trim() || 'WA PRO';
const DEFAULT_LOGO_URL = '/Logo.png';
const APP_LOGO_URL = String(import.meta.env.VITE_APP_LOGO_URL || DEFAULT_LOGO_URL).trim() || DEFAULT_LOGO_URL;

function appInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'WA';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

const Login: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const logoCandidates = useMemo(() => Array.from(new Set([APP_LOGO_URL, '/Logo.png', '/logo.png'])), []);
  const [logoAttempt, setLogoAttempt] = useState(0);
  const logoSrc = logoCandidates[Math.min(logoAttempt, logoCandidates.length - 1)];

  useEffect(() => {
    if (mockService.isAuthenticated()) {
      navigate('/inbox', { replace: true });
    }
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await mockService.authenticateUser(email, password);
    setLoading(false);

    if (!result.success) {
      setError(result.error || 'Não foi possível autenticar.');
      return;
    }

    navigate('/inbox', { replace: true });
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
        <div className="mb-4 flex items-center gap-3">
          {!logoFailed ? (
            <img
              src={logoSrc}
              alt={`${APP_NAME} Logo`}
              className="h-10 w-10 rounded-xl object-cover"
              onError={() => {
                if (logoAttempt < logoCandidates.length - 1) {
                  setLogoAttempt((prev) => prev + 1);
                  return;
                }
                setLogoFailed(true);
              }}
            />
          ) : (
            <div className="h-10 w-10 rounded-xl bg-whatsapp-600 text-white text-sm font-bold flex items-center justify-center">
              {appInitials(APP_NAME)}
            </div>
          )}
          <div>
            <p className="text-base font-semibold text-gray-900">{APP_NAME}</p>
            <p className="text-xs text-gray-500">Acesso de equipa</p>
          </div>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-1">Entrar</h1>
        <p className="text-sm text-gray-500 mb-6">Use o email e a palavra-passe do funcionário.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <div className="mt-1 relative">
              <Mail size={16} className="absolute left-3 top-3 text-gray-400" />
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                placeholder="funcionario@empresa.pt"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Palavra-passe</label>
            <div className="mt-1 relative">
              <Lock size={16} className="absolute left-3 top-3 text-gray-400" />
              <input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                placeholder="********"
              />
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-md bg-whatsapp-600 hover:bg-whatsapp-700 text-white font-medium disabled:opacity-60"
          >
            {loading ? 'A validar...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
