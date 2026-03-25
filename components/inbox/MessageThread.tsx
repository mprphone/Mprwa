import React, { useMemo, useState } from 'react';
import { CheckSquare, Copy, CornerUpLeft, Download, ExternalLink, FileText, Forward, Info, ListPlus, MoreVertical, Pencil, Pin, Star, Trash2 } from 'lucide-react';
import { Message, User } from '../../types';

type MessageThreadProps = {
  messages: Message[];
  loggedUser?: User;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  onCreateTaskFromMessage: (messageBody: string) => void;
  onReplyMessage: (message: Message) => void;
  onForwardMessage: (message: Message) => void;
  onEditMessage: (message: Message) => void;
  onDeleteMessage: (message: Message) => void;
  onDropLocalFiles: (files: File[]) => void;
  onDropCustomerDocument: (relativePath: string, fileName: string) => void;
  selectedMessageIds: string[];
  starredMessageIds: string[];
  pinnedMessageId: string | null;
  onToggleSelectMessage: (message: Message) => void;
  onToggleStarMessage: (message: Message) => void;
  onTogglePinMessage: (message: Message) => void;
  onShowMessageDetails: (message: Message) => void;
};

const MessageThread: React.FC<MessageThreadProps> = ({
  messages,
  loggedUser,
  messagesEndRef,
  onCreateTaskFromMessage,
  onReplyMessage,
  onForwardMessage,
  onEditMessage,
  onDeleteMessage,
  onDropLocalFiles,
  onDropCustomerDocument,
  selectedMessageIds,
  starredMessageIds,
  pinnedMessageId,
  onToggleSelectMessage,
  onToggleStarMessage,
  onTogglePinMessage,
  onShowMessageDetails,
}) => {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [isDropActive, setIsDropActive] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [brokenImageByMessageId, setBrokenImageByMessageId] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{
    message: Message;
    x: number;
    y: number;
  } | null>(null);

  const groupedMessages = useMemo(() => {
    const formatter = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon' });
    const groups: Array<{ key: string; label: string; items: Message[] }> = [];
    const now = new Date();
    const todayKey = formatter.format(now);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = formatter.format(yesterday);

    messages.forEach((message) => {
      const date = new Date(message.timestamp);
      const key = formatter.format(date);
      let label = date.toLocaleDateString('pt-PT', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      });
      if (key === todayKey) label = 'Hoje';
      if (key === yesterdayKey) label = 'Ontem';

      const last = groups[groups.length - 1];
      if (last && last.key === key) {
        last.items.push(message);
      } else {
        groups.push({ key, label, items: [message] });
      }
    });

    return groups;
  }, [messages]);

  const pinnedMessage = useMemo(() => {
    if (!pinnedMessageId) return null;
    return messages.find((message) => message.id === pinnedMessageId) || null;
  }, [messages, pinnedMessageId]);

  const resolveOutboundAck = (status?: string) => {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'read') {
      return { ticks: '✓✓', className: 'text-sky-500', title: 'Lida' };
    }
    if (normalized === 'delivered') {
      return { ticks: '✓✓', className: 'text-gray-500', title: 'Entregue' };
    }
    return { ticks: '✓', className: 'text-gray-500', title: 'Enviada' };
  };

  const resolveMessageMediaToken = (message: Message) => {
    const explicitPreview = String(message.mediaPreviewUrl || '').trim();
    const explicitDownload = String(message.mediaDownloadUrl || '').trim();
    if (explicitPreview || explicitDownload) return { previewUrl: explicitPreview, downloadUrl: explicitDownload };

    const mediaKind = String(message.mediaKind || '').trim().toLowerCase();
    const hasMedia = Boolean(mediaKind || message.type === 'image' || message.type === 'document');
    if (!hasMedia) return { previewUrl: '', downloadUrl: '' };
    const token = encodeURIComponent(String(message.id || '').trim());
    if (!token) return { previewUrl: '', downloadUrl: '' };
    return {
      previewUrl: `/api/chat/messages/${token}/media`,
      downloadUrl: `/api/chat/messages/${token}/media?download=1`,
    };
  };

  const resolveMessageMediaName = (message: Message) => {
    const explicit = String(message.mediaFileName || '').trim();
    if (explicit) return explicit;
    const firstLine = String(message.body || '').split('\n')[0] || '';
    const fromPrefix = firstLine.replace(/^\[(?:Imagem|Documento)\]\s*/i, '').trim();
    if (fromPrefix && fromPrefix !== firstLine.trim()) return fromPrefix;
    return message.type === 'image' ? 'imagem' : 'documento';
  };

  const resolveMessageMediaCaption = (message: Message) => {
    const raw = String(message.body || '').trim();
    if (!raw) return '';
    if (!/^\[(?:Imagem|Documento)\]/i.test(raw)) return raw;
    const lines = raw.split('\n');
    return lines.slice(1).join('\n').trim();
  };

  const resolveMessageMediaKind = (message: Message): 'image' | 'document' | 'none' => {
    const explicit = String(message.mediaKind || '').trim().toLowerCase();
    if (explicit === 'image') return 'image';
    if (explicit === 'document') return 'document';
    if (message.type === 'image') return 'image';
    if (message.type === 'document') return 'document';
    return 'none';
  };

  return (
    <div
      className={`flex-1 overflow-y-auto px-3 py-4 transition-colors ${isDropActive ? 'bg-whatsapp-50/60' : ''}`}
      onClick={() => {
        setOpenMenuId(null);
        setContextMenu(null);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDropActive(true);
      }}
      onDragLeave={() => setIsDropActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDropActive(false);
        const fromSidebarPath = event.dataTransfer.getData('application/x-wa-doc-path');
        const fromSidebarName = event.dataTransfer.getData('application/x-wa-doc-name');
        if (fromSidebarPath) {
          onDropCustomerDocument(fromSidebarPath, fromSidebarName || 'documento');
          return;
        }
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length > 0) {
          onDropLocalFiles(files);
        }
      }}
    >
      <div className="w-full min-w-0 space-y-4">
        {pinnedMessage && (
          <div className="sticky top-0 z-10 flex justify-center">
            <div className="inline-flex max-w-[70%] items-center gap-2 rounded-full border border-whatsapp-200 bg-white/95 px-3 py-1 text-[11px] text-gray-700 shadow-sm">
              <Pin size={12} className="text-whatsapp-700" />
              <span className="truncate">{pinnedMessage.body}</span>
            </div>
          </div>
        )}
        {groupedMessages.map((group) => (
          <div key={group.key} className="space-y-2">
            <div className="flex justify-center">
              <span className="rounded-full bg-white/85 px-3 py-1 text-[11px] text-gray-600 shadow-sm">
                {group.label}
              </span>
            </div>

            {group.items.map((msg) => {
              const outboundAck = resolveOutboundAck(msg.status);
              const mediaKind = resolveMessageMediaKind(msg);
              const media = resolveMessageMediaToken(msg);
              const mediaName = resolveMessageMediaName(msg);
              const mediaCaption = resolveMessageMediaCaption(msg);
              const canPreviewImage = mediaKind === 'image' && Boolean(media.previewUrl) && !brokenImageByMessageId[msg.id];
              return (
              <div key={msg.id} className={`flex ${msg.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                <div className={`flex max-w-[72%] items-end gap-2 ${msg.direction === 'out' ? 'flex-row' : 'flex-row-reverse'}`}>
                  <div
                    draggable
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setOpenMenuId(null);
                      const menuWidth = 208;
                      const menuHeight = 320;
                      const x = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
                      const y = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
                      setContextMenu({
                        message: msg,
                        x: Math.max(8, x),
                        y: Math.max(8, y),
                      });
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-wa-message-body', String(msg.body || ''));
                      event.dataTransfer.setData('text/plain', String(msg.body || ''));
                    }}
                    className={`px-4 py-2 rounded-2xl shadow-sm text-sm relative group ${
                      msg.direction === 'out'
                        ? `${msg.type === 'template' ? 'bg-amber-100 border border-amber-200' : 'bg-whatsapp-100'} text-gray-900 rounded-br-md`
                        : 'bg-white text-gray-900 rounded-bl-md'
                    } ${selectedMessageIds.includes(msg.id) ? 'ring-2 ring-whatsapp-300' : ''}`}
                  >
                    <div className="absolute right-2 top-1.5 flex items-center gap-1 text-gray-500">
                      {starredMessageIds.includes(msg.id) && <Star size={11} className="fill-yellow-400 text-yellow-500" />}
                      {pinnedMessageId === msg.id && <Pin size={11} className="text-whatsapp-700" />}
                    </div>

                    {mediaKind === 'image' && media.previewUrl ? (
                      <div className="space-y-2">
                        {canPreviewImage ? (
                          <button
                            type="button"
                            onClick={() => setPreviewImage({ src: media.previewUrl, name: mediaName })}
                            className="block overflow-hidden rounded-xl border border-white/70 bg-white/80"
                            title="Abrir imagem"
                          >
                            <img
                              src={media.previewUrl}
                              alt={mediaName}
                              loading="lazy"
                              onError={() =>
                                setBrokenImageByMessageId((prev) => ({
                                  ...prev,
                                  [msg.id]: true,
                                }))
                              }
                              className="max-h-72 w-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
                            <div>Pré-visualização indisponível para esta imagem.</div>
                            {media.downloadUrl && (
                              <a
                                href={media.downloadUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                              >
                                <Download size={12} /> Download
                              </a>
                            )}
                          </div>
                        )}
                        {mediaCaption && (
                          <p className="break-words whitespace-pre-wrap text-sm text-gray-900">{mediaCaption}</p>
                        )}
                      </div>
                    ) : mediaKind === 'document' && media.previewUrl ? (
                      <div className="space-y-2">
                        <div className="rounded-xl border border-gray-200 bg-white/80 px-3 py-2">
                          <div className="flex items-center gap-2 text-sm font-medium text-gray-800">
                            <FileText size={14} className="text-gray-600" />
                            <span className="truncate">{mediaName}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <a
                              href={media.previewUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              <ExternalLink size={12} /> Pré-visualizar
                            </a>
                            <a
                              href={media.downloadUrl || `${media.previewUrl}?download=1`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              <Download size={12} /> Download
                            </a>
                          </div>
                        </div>
                        {mediaCaption && (
                          <p className="break-words whitespace-pre-wrap text-sm text-gray-900">{mediaCaption}</p>
                        )}
                      </div>
                    ) : (
                      <p className="break-words whitespace-pre-wrap">{msg.body}</p>
                    )}

                    <div className="flex justify-end items-center gap-1 mt-1">
                      <span className="text-[10px] text-gray-500">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {msg.type === 'template' && ' • Template'}
                      </span>
                      {msg.direction === 'out' && (
                        <span
                          className={`${outboundAck.className} text-[10px]`}
                          title={outboundAck.title}
                        >
                          {outboundAck.ticks}
                        </span>
                      )}
                    </div>

                    <div className={`absolute top-1 ${msg.direction === 'out' ? '-left-9' : '-right-9'} opacity-0 group-hover:opacity-100 transition-opacity`}>
                      <div className="relative">
                        <button
                          onClick={() => setOpenMenuId((prev) => (prev === msg.id ? null : msg.id))}
                          className="p-1.5 text-gray-500 hover:text-gray-700 bg-white border border-gray-200 rounded-full shadow-sm"
                          title="Mais ações"
                        >
                          <MoreVertical size={14} />
                        </button>

                        {openMenuId === msg.id && (
                          <div
                            onClick={(event) => event.stopPropagation()}
                            className={`absolute z-20 mt-1 w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg ${msg.direction === 'out' ? 'right-0' : 'left-0'}`}
                          >
                            <button
                              onClick={() => {
                                setOpenMenuId(null);
                                onReplyMessage(msg);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              <CornerUpLeft size={13} /> Responder
                            </button>
                            <button
                              onClick={() => {
                                setOpenMenuId(null);
                                onForwardMessage(msg);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              <Forward size={13} /> Reencaminhar
                            </button>
                            <button
                              onClick={() => {
                                setOpenMenuId(null);
                                onCreateTaskFromMessage(msg.body);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              <ListPlus size={13} /> Criar tarefa
                            </button>
                            {msg.direction === 'out' && (
                              <button
                                onClick={() => {
                                  setOpenMenuId(null);
                                  onEditMessage(msg);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
                              >
                                <Pencil size={13} /> Editar
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setOpenMenuId(null);
                                onDeleteMessage(msg);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-red-50"
                            >
                              <Trash2 size={13} /> Apagar
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {msg.direction === 'out' && (
                    <img
                      src={loggedUser?.avatarUrl || 'https://ui-avatars.com/api/?name=User&background=random'}
                      alt={loggedUser?.name || 'Funcionário'}
                      title={loggedUser?.name || 'Funcionário'}
                      className="w-7 h-7 rounded-full bg-gray-200 object-cover"
                    />
                  )}
                </div>
              </div>
              );
            })}
          </div>
        ))}
      </div>
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="max-h-[92vh] max-w-[92vw] overflow-hidden rounded-xl bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2">
              <span className="truncate text-sm font-medium text-gray-700">{previewImage.name}</span>
              <button
                type="button"
                onClick={() => setPreviewImage(null)}
                className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
              >
                Fechar
              </button>
            </div>
            <img
              src={previewImage.src}
              alt={previewImage.name}
              className="max-h-[84vh] max-w-[92vw] object-contain"
            />
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          className="fixed z-40 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-xl"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => {
              setContextMenu(null);
              onShowMessageDetails(contextMenu.message);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <Info size={13} /> Detalhes da mensagem
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              onReplyMessage(contextMenu.message);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <CornerUpLeft size={13} /> Responder
          </button>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(String(contextMenu.message.body || ''));
              } catch {
                // no-op clipboard fallback
              }
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <Copy size={13} /> Copiar texto
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              onForwardMessage(contextMenu.message);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <Forward size={13} /> Reencaminhar
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              onTogglePinMessage(contextMenu.message);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <Pin size={13} /> {pinnedMessageId === contextMenu.message.id ? 'Desafixar' : 'Afixar'}
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              onToggleStarMessage(contextMenu.message);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <Star size={13} /> {starredMessageIds.includes(contextMenu.message.id) ? 'Remover estrela' : 'Marcar com estrela'}
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              onToggleSelectMessage(contextMenu.message);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <CheckSquare size={13} /> {selectedMessageIds.includes(contextMenu.message.id) ? 'Desselecionar' : 'Selecionar'}
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              onCreateTaskFromMessage(contextMenu.message.body);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
          >
            <ListPlus size={13} /> Criar tarefa
          </button>
          {contextMenu.message.direction === 'out' && (
            <button
              onClick={() => {
                setContextMenu(null);
                onEditMessage(contextMenu.message);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
            >
              <Pencil size={13} /> Editar
            </button>
          )}
          <button
            onClick={() => {
              setContextMenu(null);
              onDeleteMessage(contextMenu.message);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-red-50"
          >
            <Trash2 size={13} /> Apagar
          </button>
        </div>
      )}
      {messages.length === 0 && (
        <div className="text-center text-gray-400 py-10">
          <p className="text-sm">Esta é uma nova conversa.</p>
          <p className="text-xs">Envie a primeira mensagem para iniciar.</p>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default MessageThread;
