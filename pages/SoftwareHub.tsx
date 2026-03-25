import React, { useEffect, useMemo, useRef, useState } from 'react';
import { mockService } from '../services/mockData';
import { Role } from '../types';
import { AppWindow, Trash2, ExternalLink, Save, X, Pencil, Plus, Download } from 'lucide-react';

type SoftwareLink = {
  id: string;
  name: string;
  url: string;
  imageUrl: string;
};

type DesktopBuild = {
  name: string;
  version?: string | null;
  sizeBytes: number;
  updatedAt: string | null;
};

const STORAGE_KEY = 'wa_pro_software_links_v1';

const DEFAULT_SOFTWARES: SoftwareLink[] = [
  { id: 'sw_1', name: 'Divisão de faturas', url: '', imageUrl: '' },
  { id: 'sw_2', name: 'Extração PDF', url: '', imageUrl: '' },
  { id: 'sw_3', name: 'Gestão Cliente', url: '', imageUrl: '' },
  { id: 'sw_4', name: 'Inventários', url: '', imageUrl: '' },
  { id: 'sw_5', name: 'Primavera Importer', url: '', imageUrl: '' },
  { id: 'sw_6', name: 'Reconciliação bancária', url: '', imageUrl: '' },
  { id: 'sw_7', name: 'Stand', url: '', imageUrl: '' },
];

function normalizeUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function sanitizeSoftwareLinks(raw: unknown): SoftwareLink[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const cleaned: SoftwareLink[] = [];
  raw.forEach((item) => {
    const id = String((item as SoftwareLink)?.id || `sw_${Math.random().toString(36).slice(2, 9)}`).trim();
    const name = String((item as SoftwareLink)?.name || '').trim();
    const url = String((item as SoftwareLink)?.url || '').trim();
    const imageUrl = String((item as SoftwareLink)?.imageUrl || '').trim();
    if (!id || !name || seenIds.has(id)) return;
    seenIds.add(id);
    cleaned.push({ id, name, url, imageUrl });
  });
  return cleaned;
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeDom = error as DOMException;
  if (maybeDom.name === 'QuotaExceededError' || maybeDom.code === 22 || maybeDom.code === 1014) return true;
  const message = String((error as { message?: unknown })?.message || '').toLowerCase();
  return message.includes('quota') && message.includes('exceed');
}

function compactSoftwareLinksForCache(links: SoftwareLink[]): SoftwareLink[] {
  return sanitizeSoftwareLinks(links).map((item) => {
    const image = String(item.imageUrl || '').trim();
    if (!image) return { ...item, imageUrl: '' };
    // Data URLs podem rebentar rapidamente o limite do localStorage.
    if (/^data:image\//i.test(image)) {
      return { ...item, imageUrl: '' };
    }
    return { ...item, imageUrl: image };
  });
}

function persistSoftwareLinksToStorage(links: SoftwareLink[]): 'ok' | 'compact' | 'failed' {
  if (typeof window === 'undefined') return 'ok';
  const cleaned = sanitizeSoftwareLinks(links);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    return 'ok';
  } catch (error) {
    if (!isQuotaExceededError(error)) return 'failed';
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(compactSoftwareLinksForCache(cleaned)));
      return 'compact';
    } catch {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignorar
      }
      return 'failed';
    }
  }
}

function loadStoredSoftwareLinks(): SoftwareLink[] {
  if (typeof window === 'undefined') return DEFAULT_SOFTWARES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SOFTWARES;
    const parsed = JSON.parse(raw) as unknown;
    const cleaned = sanitizeSoftwareLinks(parsed);
    return cleaned.length > 0 ? cleaned : DEFAULT_SOFTWARES;
  } catch {
    return DEFAULT_SOFTWARES;
  }
}

async function fetchServerSoftwareLinks(): Promise<SoftwareLink[]> {
  const response = await fetch('/api/software-links', {
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || `Falha ao carregar links (${response.status}).`);
  }
  const cleaned = sanitizeSoftwareLinks(payload?.data);
  return cleaned;
}

async function saveServerSoftwareLinks(links: SoftwareLink[], actorUserId: string): Promise<void> {
  const response = await fetch('/api/software-links', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links, actorUserId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || `Falha ao guardar links (${response.status}).`);
  }
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Falha ao ler imagem.'));
    reader.readAsDataURL(file);
  });
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = units[0];
  for (let i = 0; i < units.length; i += 1) {
    unit = units[i];
    if (size < 1024 || i === units.length - 1) break;
    size /= 1024;
  }
  const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${unit}`;
}

const SoftwareHub: React.FC = () => {
  const currentUser = mockService.getCurrentUser();
  const isAdmin = currentUser?.role === Role.ADMIN;

  const [softwareLinks, setSoftwareLinks] = useState<SoftwareLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksSyncError, setLinksSyncError] = useState('');
  const [linksCacheWarning, setLinksCacheWarning] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [formError, setFormError] = useState('');

  const [desktopBuilds, setDesktopBuilds] = useState<DesktopBuild[]>([]);
  const [desktopAppVersion, setDesktopAppVersion] = useState('');
  const [desktopLatestBuildVersion, setDesktopLatestBuildVersion] = useState('');
  const [desktopHasCurrentBuild, setDesktopHasCurrentBuild] = useState(true);
  const [desktopLoading, setDesktopLoading] = useState(true);
  const [desktopError, setDesktopError] = useState('');
  const loadedFromServerRef = useRef(false);
  const skipInitialPersistRef = useRef(true);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const localLinks = loadStoredSoftwareLinks();
    setSoftwareLinks(localLinks);

    const loadFromServer = async () => {
      setLinksLoading(true);
      setLinksSyncError('');
      try {
        const serverLinks = await fetchServerSoftwareLinks();
        if (cancelled) return;
        if (serverLinks.length > 0) {
          setSoftwareLinks(serverLinks);
        } else if (localLinks.length > 0) {
          await saveServerSoftwareLinks(localLinks, String(currentUser?.id || '').trim());
        }
        loadedFromServerRef.current = true;
      } catch (error: any) {
        if (cancelled) return;
        setLinksSyncError(String(error?.message || 'Falha ao sincronizar links de software.'));
        loadedFromServerRef.current = true;
      } finally {
        if (!cancelled) setLinksLoading(false);
      }
    };

    void loadFromServer();
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const persisted = persistSoftwareLinksToStorage(softwareLinks);
    if (persisted === 'compact') {
      setLinksCacheWarning('Armazenamento local cheio: cache guardada sem imagens pesadas neste browser.');
      return;
    }
    if (persisted === 'failed') {
      setLinksCacheWarning('Armazenamento local cheio: sem cache local. Os links continuam guardados no servidor.');
      return;
    }
    setLinksCacheWarning('');
  }, [softwareLinks]);

  useEffect(() => {
    if (!loadedFromServerRef.current) return;
    if (skipInitialPersistRef.current) {
      skipInitialPersistRef.current = false;
      return;
    }
    const actorUserId = String(currentUser?.id || '').trim();
    if (!actorUserId) return;
    void saveServerSoftwareLinks(softwareLinks, actorUserId).then(
      () => {
        setLinksSyncError('');
      },
      (error: any) => {
        setLinksSyncError(String(error?.message || 'Falha ao guardar links no servidor.'));
      },
    );
  }, [softwareLinks, currentUser?.id]);

  useEffect(() => {
    let cancelled = false;

    const loadDesktopBuilds = async () => {
      setDesktopLoading(true);
      setDesktopError('');
      try {
        const response = await fetch('/api/desktop/builds');
        const payload = await response.json();
        if (!response.ok || !payload?.success) {
          throw new Error(payload?.error || 'Falha ao listar builds desktop.');
        }
        if (!cancelled) {
          setDesktopBuilds(Array.isArray(payload?.builds) ? payload.builds : []);
          setDesktopAppVersion(String(payload?.appVersion || '').trim());
          setDesktopLatestBuildVersion(String(payload?.latestBuildVersion || '').trim());
          setDesktopHasCurrentBuild(payload?.hasCurrentBuild !== false);
        }
      } catch (error: any) {
        if (!cancelled) {
          setDesktopError(String(error?.message || 'Falha ao listar builds desktop.'));
          setDesktopBuilds([]);
          setDesktopAppVersion('');
          setDesktopLatestBuildVersion('');
          setDesktopHasCurrentBuild(true);
        }
      } finally {
        if (!cancelled) setDesktopLoading(false);
      }
    };

    loadDesktopBuilds();
    return () => {
      cancelled = true;
    };
  }, []);

  const canSave = useMemo(() => String(name || '').trim() && String(url || '').trim(), [name, url]);

  const preferredDesktopBuild = useMemo(() => {
    if (!desktopBuilds.length) return null;
    const appVersion = String(desktopAppVersion || '').trim();
    if (appVersion) {
      const currentExe = desktopBuilds.find((item) => item.version === appVersion && /\.exe$/i.test(item.name));
      if (currentExe) return currentExe;
      const currentZip = desktopBuilds.find((item) => item.version === appVersion && /\.zip$/i.test(item.name));
      if (currentZip) return currentZip;
      const currentAny = desktopBuilds.find((item) => item.version === appVersion);
      if (currentAny) return currentAny;
    }
    const exe = desktopBuilds.find((item) => /\.exe$/i.test(item.name));
    if (exe) return exe;
    const zip = desktopBuilds.find((item) => /\.zip$/i.test(item.name));
    if (zip) return zip;
    return desktopBuilds[0];
  }, [desktopBuilds, desktopAppVersion]);

  const clearForm = () => {
    setName('');
    setUrl('');
    setImageUrl('');
    setFormError('');
    setEditingId(null);
  };

  const closeModal = () => {
    setShowModal(false);
    clearForm();
  };

  const openCreateModal = () => {
    clearForm();
    setShowModal(true);
  };

  const openEditModal = (item: SoftwareLink) => {
    setEditingId(item.id);
    setName(item.name);
    setUrl(item.url);
    setImageUrl(item.imageUrl || '');
    setFormError('');
    setShowModal(true);
  };

  const handleModalImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFormError('Selecione um ficheiro de imagem válido.');
      return;
    }
    if (file.size > 1024 * 1024 * 2) {
      setFormError('A imagem deve ter no máximo 2MB.');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setImageUrl(dataUrl);
      setFormError('');
    } catch (error: any) {
      setFormError(String(error?.message || 'Falha ao carregar imagem.'));
    }
  };

  const saveSoftware = () => {
    const nextName = String(name || '').trim();
    const nextUrl = normalizeUrl(url);
    const nextImageUrl = String(imageUrl || '').trim();
    if (!nextName || !nextUrl) return;
    if (nextImageUrl && !/^https?:\/\//i.test(nextImageUrl) && !/^data:image\//i.test(nextImageUrl)) {
      setFormError('A imagem deve ser um URL (http/https) ou imagem carregada.');
      return;
    }

    if (editingId) {
      setSoftwareLinks((prev) =>
        prev.map((item) => (item.id === editingId ? { ...item, name: nextName, url: nextUrl, imageUrl: nextImageUrl } : item)),
      );
      closeModal();
      return;
    }

    const nextItem: SoftwareLink = {
      id: `sw_${Date.now()}`,
      name: nextName,
      url: nextUrl,
      imageUrl: nextImageUrl,
    };

    setSoftwareLinks((prev) => [nextItem, ...prev]);
    closeModal();
  };

  const removeSoftware = (id: string) => {
    if (!window.confirm('Remover este software da lista?')) return;
    setSoftwareLinks((prev) => prev.filter((item) => item.id !== id));
  };

  const openSoftware = (item: SoftwareLink) => {
    const targetUrl = normalizeUrl(item.url);
    if (!targetUrl) {
      window.alert('Este software ainda não tem link configurado.');
      return;
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  const downloadDesktop = () => {
    if (!preferredDesktopBuild) {
      window.alert('Ainda não existe build desktop disponível no servidor.');
      return;
    }
    window.open(`/api/desktop/download/${encodeURIComponent(preferredDesktopBuild.name)}`, '_blank');
  };

  return (
    <div className="p-4 md:p-6 w-full space-y-4">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 md:p-5 text-white shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Software</h1>
            <p className="text-xs md:text-sm text-slate-200">Menu de softwares MPR concentrado num único local.</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={downloadDesktop}
              disabled={desktopLoading || !preferredDesktopBuild}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-whatsapp-600 hover:bg-whatsapp-500 text-white text-xs md:text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Download size={16} />
              Instalar App Desktop
            </button>

            {isAdmin && (
              <button
                type="button"
                onClick={openCreateModal}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs md:text-sm font-semibold"
              >
                <Plus size={16} />
                Novo Software
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 text-xs text-slate-200/95">
          {desktopLoading && <span>A verificar versão desktop disponível...</span>}
          {!desktopLoading && preferredDesktopBuild && (
            <span>
              Build disponível: <strong>{preferredDesktopBuild.name}</strong> ({formatBytes(preferredDesktopBuild.sizeBytes)})
            </span>
          )}
          {!desktopLoading && !preferredDesktopBuild && !desktopError && (
            <span>Sem build desktop no servidor. Pede para gerar o pacote Windows.</span>
          )}
          {!desktopLoading && desktopError && <span>Desktop: {desktopError}</span>}
        </div>
        {!desktopLoading && !desktopError && desktopAppVersion && (
          <div className="mt-1 text-xs text-slate-200/95">
            Versão atual da app: <strong>v{desktopAppVersion}</strong>
            {desktopLatestBuildVersion ? (
              <>
                {' '}| Última build disponível: <strong>v{desktopLatestBuildVersion}</strong>
              </>
            ) : null}
          </div>
        )}
        {!desktopLoading && !desktopError && !desktopHasCurrentBuild && (
          <div className="mt-1 text-xs text-amber-100/95">
            Ainda não existe instalador da versão atual no servidor. Publica a nova build para os colaboradores descarregarem a versão certa.
          </div>
        )}
        <div className="mt-1 text-xs text-slate-200/95">
          {linksLoading && <span>A sincronizar links de software...</span>}
          {!linksLoading && !linksSyncError && <span>Links partilhados ativos: alterações replicadas para outros PCs.</span>}
          {!linksLoading && linksSyncError && <span>Links: {linksSyncError}</span>}
        </div>
        {!linksLoading && linksCacheWarning && (
          <div className="mt-1 text-xs text-amber-100/95">
            {linksCacheWarning}
          </div>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        {softwareLinks.map((item) => (
          <div key={item.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col min-h-[240px]">
            <div className="flex items-start justify-end gap-2">
              {isAdmin && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEditModal(item)}
                    className="text-slate-500 hover:text-blue-700 p-1 rounded"
                    title="Editar"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSoftware(item.id)}
                    className="text-red-500 hover:text-red-700 p-1 rounded"
                    title="Remover"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-3 -mt-1">
              <div
                className={`rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 overflow-hidden border border-blue-100 ${
                  item.imageUrl ? 'h-28 w-28' : 'h-20 w-20'
                }`}
              >
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <AppWindow size={24} />
                )}
              </div>
              {!item.imageUrl && <h3 className="text-lg font-semibold text-slate-900 leading-tight text-center">{item.name}</h3>}
            </div>

            <button
              type="button"
              onClick={() => openSoftware(item)}
              className="mt-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-whatsapp-600 hover:bg-whatsapp-500 text-white text-base font-semibold"
            >
              <ExternalLink size={16} />
              Abrir
            </button>
          </div>
        ))}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl p-5 space-y-4 border border-slate-200 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-slate-900">{editingId ? 'Editar Software' : 'Novo Software'}</h2>
              <button
                type="button"
                onClick={closeModal}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm"
              >
                <X size={14} />
                Fechar
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nome</label>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Nome do Software (ex: MPR Gestão)"
                  className="w-full px-3 py-2 border border-slate-200 rounded-md bg-slate-50 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Link</label>
                <input
                  type="text"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="Link (https://...)"
                  className="w-full px-3 py-2 border border-slate-200 rounded-md bg-slate-50 text-sm"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Imagem do programa</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={imageUrl}
                    onChange={(event) => {
                      setImageUrl(event.target.value);
                      if (formError) setFormError('');
                    }}
                    placeholder="URL da imagem (https://...) ou carregue um ficheiro"
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-md bg-slate-50 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm"
                  >
                    Carregar
                  </button>
                  {imageUrl && (
                    <button
                      type="button"
                      onClick={() => setImageUrl('')}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-red-50 hover:bg-red-100 text-red-700 text-sm"
                    >
                      Limpar
                    </button>
                  )}
                </div>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    void handleModalImageUpload(event);
                  }}
                />
                {imageUrl && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                    <img src={imageUrl} alt="Pré-visualização" className="h-12 w-12 rounded-md border border-slate-200 object-cover" />
                    <span className="text-xs text-slate-600 truncate">Pré-visualização da imagem do software.</span>
                  </div>
                )}
                {formError && <p className="mt-1 text-xs text-red-600">{formError}</p>}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={closeModal}
                className="inline-flex items-center gap-1 px-4 py-2 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold"
              >
                <X size={14} />
                Cancelar
              </button>
              <button
                type="button"
                onClick={saveSoftware}
                disabled={!canSave}
                className="inline-flex items-center gap-1 px-4 py-2 rounded-md bg-whatsapp-600 hover:bg-whatsapp-500 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save size={14} />
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SoftwareHub;
