import React, { useState, useEffect } from 'react';
import { mockService } from '../services/mockData';
import { User, Role } from '../types';
import { Plus, Search, Mail, Shield, Edit2, Sparkles, Trash2 } from 'lucide-react';
import { fetchInternalPresence, InternalPresenceRow } from '../services/internalChatApi';

const Employees: React.FC = () => {
  const [employees, setEmployees] = useState<User[]>([]);
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, InternalPresenceRow>>({});
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [deletingUserId, setDeletingUserId] = useState('');
  const [formData, setFormData] = useState({ 
    name: '', 
    email: '', 
    password: '', 
    role: Role.AGENT,
    avatarUrl: '',
    isAiAssistant: false,
    aiAllowedSitesText: '',
  });

  const currentUserId = String(mockService.getCurrentUserId() || '').trim();

  useEffect(() => {
    loadEmployees();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPresence = async () => {
      const userIds = employees
        .map((user) => String(user?.id || '').trim())
        .filter(Boolean);
      if (!currentUserId || userIds.length === 0) {
        if (!cancelled) setPresenceByUserId({});
        return;
      }

      try {
        const rows = await fetchInternalPresence({
          userId: currentUserId,
          userIds,
          windowSeconds: 75,
          touch: false,
        });
        if (cancelled) return;
        const nextMap: Record<string, InternalPresenceRow> = {};
        (Array.isArray(rows) ? rows : []).forEach((row) => {
          const key = String(row?.userId || '').trim();
          if (!key) return;
          nextMap[key] = row;
        });
        setPresenceByUserId(nextMap);
      } catch (_) {
        if (!cancelled) setPresenceByUserId({});
      }
    };

    void loadPresence();
    const interval = window.setInterval(() => {
      void loadPresence();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [employees, currentUserId]);

  const loadEmployees = async () => {
    const data = await mockService.getUsers();
    setEmployees(data);
  };


  const compressImageToDataUrl = async (file: File): Promise<string> => {
    const rawDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }
        reject(new Error('Falha ao ler imagem.'));
      };
      reader.onerror = () => reject(new Error('Falha ao ler imagem.'));
      reader.readAsDataURL(file);
    });

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Falha ao processar imagem.'));
      img.src = rawDataUrl;
    });

    const targetSize = 512;
    const cropSize = Math.max(1, Math.min(image.width, image.height));
    const sourceX = Math.max(0, Math.floor((image.width - cropSize) / 2));
    const sourceY = Math.max(0, Math.floor((image.height - cropSize) / 2));
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Falha ao preparar imagem.');

    // Normaliza para quadrado para evitar imagens achatadas no avatar.
    ctx.drawImage(image, sourceX, sourceY, cropSize, cropSize, 0, 0, targetSize, targetSize);

    // Alvo pequeno para evitar erro 413 em uploads.
    const maxBytes = 350 * 1024;
    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (quality > 0.45) {
      const approxBytes = Math.ceil((dataUrl.length * 3) / 4);
      if (approxBytes <= maxBytes) break;
      quality -= 0.08;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    return dataUrl;
  };

  const openModal = (user?: User) => {
      if (user) {
          setEditingUser(user);
          setFormData({
              name: user.name,
              email: user.email,
              password: user.password || '',
              role: user.role,
              avatarUrl: user.avatarUrl || '',
              isAiAssistant: !!user.isAiAssistant,
              aiAllowedSitesText: Array.isArray(user.aiAllowedSites) ? user.aiAllowedSites.join('\n') : '',
          });
      } else {
          setEditingUser(null);
          setFormData({ name: '', email: '', password: '', role: Role.AGENT, avatarUrl: '', isAiAssistant: false, aiAllowedSitesText: '' });
      }
      setShowModal(true);
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Selecione um ficheiro de imagem válido.');
      return;
    }

    try {
      const compressedDataUrl = await compressImageToDataUrl(file);
      setFormData(prev => ({ ...prev, avatarUrl: compressedDataUrl }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível processar a imagem.';
      alert(message);
    } finally {
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const aiAllowedSites = formData.aiAllowedSitesText
        .split(/\r?\n|,/g)
        .map((item) => item.trim())
        .filter(Boolean);

      if (editingUser) {
          await mockService.updateUser(editingUser.id, {
              name: formData.name,
              email: formData.email,
              role: formData.role,
              password: formData.password,
              avatarUrl: formData.avatarUrl,
              isAiAssistant: formData.isAiAssistant,
              aiAllowedSites,
          });
      } else {
          await mockService.createUser({
              name: formData.name,
              email: formData.email,
              password: formData.password,
              role: formData.role,
              avatarUrl: formData.avatarUrl,
              isAiAssistant: formData.isAiAssistant,
              aiAllowedSites,
          });
      }

      setShowModal(false);
      await loadEmployees();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao guardar funcionário.';
      alert(message);
    }
  };

  const handleDeleteEmployee = async (user: User) => {
    const targetId = String(user?.id || '').trim();
    if (!targetId) return;
    if (targetId === currentUserId) {
      alert('Não pode eliminar o seu próprio utilizador.');
      return;
    }

    const targetName = String(user?.name || 'Funcionário').trim();
    if (!window.confirm(`Eliminar o funcionário \"${targetName}\"?`)) return;

    setDeletingUserId(targetId);
    try {
      await mockService.deleteUser(targetId, currentUserId);
      await loadEmployees();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao eliminar funcionário.';
      alert(message);
    } finally {
      setDeletingUserId('');
    }
  };

  const formatPresenceLabel = (presence: InternalPresenceRow | null): string => {
    if (presence?.isOnline) return 'Online';

    const lastSeen = String(presence?.lastSeenAt || '').trim();
    if (!lastSeen) return 'Offline';

    const lastSeenDate = new Date(lastSeen);
    if (!Number.isFinite(lastSeenDate.getTime())) return 'Offline';

    const diffMs = Date.now() - lastSeenDate.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return 'Visto agora';
    if (diffMinutes < 60) return `Visto há ${diffMinutes} min`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `Visto há ${diffHours} h`;

    return `Visto ${lastSeenDate.toLocaleDateString('pt-PT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })}`;
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Funcionários</h1>
            <p className="text-xs text-slate-200 md:text-sm">Gestão e permissões da equipa interna.</p>
          </div>
          <button
            onClick={() => openModal()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 md:text-sm"
          >
            <Plus size={16} />
            Novo Funcionário
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-3">
           <div className="relative max-w-md">
             <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
             <input type="text" placeholder="Procurar funcionário..." className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm" />
           </div>
        </div>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
             <tr>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Funcionário</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Função</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Estado</th>
               <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Ações</th>
             </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
             {employees.map(user => {
               const presence = presenceByUserId[String(user?.id || '').trim()] || null;
               return (
               <tr 
                 key={user.id} 
                 className="hover:bg-gray-50 cursor-pointer"
                 onClick={() => openModal(user)}
               >
                 <td className="px-6 py-4 whitespace-nowrap">
                   <div className="flex items-center gap-3">
                      <img src={user.avatarUrl} className="w-8 h-8 rounded-full bg-gray-200 object-cover" alt="" />
                      <div className="text-sm font-medium text-gray-900">{user.name}</div>
                   </div>
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 flex items-center gap-2">
                    <Mail size={14} /> {user.email}
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full ${user.role === Role.ADMIN ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}`}>
                          <Shield size={12} /> {user.role}
                      </span>
                      {user.isAiAssistant && (
                        <span className="px-2 py-1 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                          <Sparkles size={12} />
                          IA
                        </span>
                      )}
                    </div>
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap">
                    <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700">
                      <span className={`h-2 w-2 rounded-full ${presence?.isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`}></span>
                      {formatPresenceLabel(presence)}
                    </div>
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button 
                        onClick={(e) => { e.stopPropagation(); openModal(user); }} 
                        className="text-gray-400 hover:text-whatsapp-600 p-2"
                        title="Editar funcionário"
                    >
                        <Edit2 size={16} />
                    </button>
                    <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteEmployee(user);
                        }}
                        disabled={deletingUserId === user.id || user.id === currentUserId}
                        className="text-gray-400 hover:text-red-600 p-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={user.id === currentUserId ? 'Não pode eliminar o seu utilizador' : 'Eliminar funcionário'}
                    >
                        <Trash2 size={16} />
                    </button>
                 </td>
               </tr>
             )})}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
           <div className="bg-white rounded-lg w-full max-w-md p-6">
              <h2 className="text-lg font-bold mb-4">
                  {editingUser ? 'Editar Funcionário' : 'Novo Funcionário'}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Foto</label>
                    <div className="mt-2 flex items-center gap-4">
                      <img
                        src={formData.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(formData.name || 'User')}&background=random`}
                        className="w-14 h-14 rounded-full bg-gray-200 object-cover"
                        alt="Foto do funcionário"
                      />
                      <div className="flex-1">
                        <input
                          type="file"
                          accept="image/*"
                          className="block w-full text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
                          onChange={handlePhotoFileChange}
                        />
                      </div>
                    </div>
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Nome</label>
                    <input required type="text" className="mt-1 w-full border rounded-md p-2" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Email</label>
                    <input required type="email" className="mt-1 w-full border rounded-md p-2" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Palavra-passe</label>
                    <input
                      required
                      type="password"
                      className="mt-1 w-full border rounded-md p-2"
                      value={formData.password}
                      onChange={e => setFormData({...formData, password: e.target.value})}
                    />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Função</label>
                    <select 
                       className="mt-1 w-full border rounded-md p-2"
                       value={formData.role}
                       onChange={e => setFormData({...formData, role: e.target.value as Role})}
                    >
                       <option value={Role.AGENT}>Agente</option>
                       <option value={Role.ADMIN}>Administrador</option>
                    </select>
                 </div>
                 <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                    <label className="inline-flex items-center gap-2 text-sm font-medium text-emerald-900">
                      <input
                        type="checkbox"
                        checked={formData.isAiAssistant}
                        onChange={(e) => setFormData({ ...formData, isAiAssistant: e.target.checked })}
                      />
                      Funcionário IA (responde no Chat Interno)
                    </label>
                    <p className="mt-1 text-xs text-emerald-800">Sites permitidos (um por linha). A IA consulta apenas estes domínios.</p>
                    <textarea
                      rows={4}
                      value={formData.aiAllowedSitesText}
                      onChange={(e) => setFormData({ ...formData, aiAllowedSitesText: e.target.value })}
                      placeholder="https://www.portaldasfinancas.gov.pt\nhttps://eportugal.gov.pt"
                      className="mt-2 w-full border rounded-md p-2 text-sm"
                    />
                  </div>
                 <div className="flex justify-end gap-2 mt-6">
                    <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-600">Cancelar</button>
                    <button type="submit" className="px-4 py-2 bg-whatsapp-600 text-white rounded-md">Guardar</button>
                 </div>
              </form>
           </div>
        </div>
      )}
    </div>
  );
};

export default Employees;
