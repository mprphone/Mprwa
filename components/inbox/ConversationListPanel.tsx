import React from 'react';
import { MessageSquarePlus, Search } from 'lucide-react';
import { Conversation, ConversationStatus, Customer, User } from '../../types';

export type InboxTab = 'mine' | 'triage' | 'waiting' | 'closed';

type ConversationListPanelProps = {
  selectedConvId: string | null;
  activeTab: InboxTab;
  templateCount: number;
  telegramOnly: boolean;
  telegramCount: number;
  conversationSearch: string;
  conversations: Conversation[];
  conversationDisplayNameById?: Record<string, string>;
  conversationContactNameById?: Record<string, string>;
  conversationChannelById?: Record<string, 'whatsapp' | 'telegram'>;
  blockedConversationIds?: Set<string>;
  customers: Customer[];
  users: User[];
  currentUserId: string;
  onSelectConversation: (conversationId: string) => void;
  onOpenNewChat: () => void;
  onConversationSearchChange: (value: string) => void;
  onTabChange: (tab: InboxTab) => void;
  onToggleTelegramOnly: () => void;
};

const TABS: Array<{ id: InboxTab; label: string }> = [
  { id: 'waiting', label: 'Todas' },
  { id: 'mine', label: 'Associadas a mim' },
  { id: 'triage', label: 'Não atribuídas' },
  { id: 'closed', label: 'Fechadas' },
];

const normalizePhoneDigits = (value?: string | null) => String(value || '').replace(/\D/g, '');
const extractPhoneDigitsFromConversationId = (conversationId?: string | null) => {
  const match = String(conversationId || '').match(/(?:wa_c_|conv_wa_c_|conv_wa_)(\d{6,})/);
  return match?.[1] || '';
};
const resolveConversationFallbackPhone = (conversation: Conversation) => {
  const digits = extractPhoneDigitsFromConversationId(conversation?.id);
  return digits ? `+${digits}` : '';
};
const looksLikePhoneLabel = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^\+?\d[\d\s-]{5,}$/.test(raw)) return true;
  const digits = normalizePhoneDigits(raw);
  return digits.length >= 7 && digits.length >= Math.max(7, raw.length - 3);
};
const resolveCustomerPrimaryLabel = (customer?: Customer | null, fallbackPhone?: string | null) => {
  const contactName = String(customer?.contactName || '').trim();
  const name = String(customer?.name || '').trim();
  const company = String(customer?.company || '').trim();
  const phone = String(fallbackPhone || customer?.phone || '').trim();
  const hasCompany = company && !looksLikePhoneLabel(company);
  const hasName = name && !looksLikePhoneLabel(name);
  const hasContactName = contactName && !looksLikePhoneLabel(contactName);
  if (hasContactName && hasCompany && contactName.toLowerCase() !== company.toLowerCase()) return `${contactName} - ${company}`;
  if (hasName && hasCompany && name.toLowerCase() !== company.toLowerCase()) return `${name} - ${company}`;
  if (hasContactName) return contactName;
  if (hasName) return name;
  if (hasCompany) return company;
  if (phone) return phone;
  return contactName || name || company;
};

const ConversationListPanel: React.FC<ConversationListPanelProps> = ({
  selectedConvId,
  activeTab,
  templateCount,
  telegramOnly,
  telegramCount,
  conversationSearch,
  conversations,
  conversationDisplayNameById = {},
  conversationContactNameById = {},
  conversationChannelById = {},
  blockedConversationIds = new Set<string>(),
  customers,
  users,
  currentUserId,
  onSelectConversation,
  onOpenNewChat,
  onConversationSearchChange,
  onTabChange,
  onToggleTelegramOnly,
}) => {
  return (
    <div className={`w-full md:w-80 bg-white border-r border-gray-200 flex flex-col ${selectedConvId ? 'hidden md:flex' : 'flex'}`}>
      <div className="p-4 border-b border-gray-200 space-y-3">
        <div className="flex justify-between items-center text-xs bg-gray-50 p-2 rounded border border-gray-200 text-gray-600">
          <span>Templates este mês:</span>
          <span className="font-bold text-whatsapp-600">{templateCount}</span>
        </div>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 text-gray-400" size={18} />
            <input
              type="text"
              placeholder="Pesquisar..."
              className="w-full pl-10 pr-4 py-2 bg-gray-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              value={conversationSearch}
              onChange={(event) => onConversationSearchChange(event.target.value)}
            />
          </div>
          <button
            onClick={onOpenNewChat}
            title="Iniciar Conversa"
            className="p-2 bg-whatsapp-600 text-white rounded-lg hover:bg-whatsapp-700 transition-colors"
          >
            <MessageSquarePlus size={20} />
          </button>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'bg-whatsapp-100 text-whatsapp-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
          <button
            onClick={onToggleTelegramOnly}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
              telegramOnly
                ? 'bg-sky-100 text-sky-700 border border-sky-300'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-transparent'
            }`}
            title="Mostrar apenas conversas Telegram"
          >
            Telegram ({telegramCount})
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.map((conv) => {
          const customer = customers.find((item) => item.id === conv.customerId);
          const fallbackPhone = resolveConversationFallbackPhone(conv);
          const conversationId = String(conv.id || '').trim();
          const resolvedDisplayName = String(conversationDisplayNameById[conversationId] || '').trim();
          const resolvedContactName = String(conversationContactNameById[conversationId] || '').trim();
          const customerName = String(customer?.name || '').trim();
          const resolvedBaseName = resolvedDisplayName.includes(' - ')
            ? resolvedDisplayName.split(' - ')[0].trim()
            : resolvedDisplayName;
          const conversationTitle =
            (resolvedContactName && !looksLikePhoneLabel(resolvedContactName) ? resolvedContactName : '') ||
            (customerName && !looksLikePhoneLabel(customerName) ? customerName : '') ||
            (resolvedBaseName && !looksLikePhoneLabel(resolvedBaseName) ? resolvedBaseName : '') ||
            resolveCustomerPrimaryLabel(customer, fallbackPhone) ||
            'Desconhecido';
          const phoneLabel = String(customer?.phone || fallbackPhone || '').trim();
          const companyLabel = String(customer?.company || '').trim();
          const conversationSubtitle =
            (companyLabel && companyLabel.toLowerCase() !== conversationTitle.toLowerCase() ? companyLabel : '') ||
            phoneLabel ||
            '--';
          const owner = users.find((item) => item.id === conv.ownerId);
          const channel = conversationChannelById[conversationId] === 'telegram' ? 'telegram' : 'whatsapp';
          const isBlocked = blockedConversationIds.has(conversationId);

          return (
            <div
              key={conv.id}
              onClick={() => onSelectConversation(conv.id)}
              className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${selectedConvId === conv.id ? 'bg-whatsapp-50' : ''}`}
            >
              <div className="flex gap-3">
                <img
                  src={`/api/avatars/${normalizePhoneDigits(customer?.phone || fallbackPhone)}`}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  className="w-10 h-10 rounded-full object-cover flex-shrink-0 mt-0.5"
                  alt=""
                />
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start mb-1">
                    <h3 className="font-semibold text-gray-900 truncate">{conversationTitle}</h3>
                    <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
                      {new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
              <p className="text-sm text-gray-600 truncate">{conversationSubtitle}</p>
              <div className="flex items-center gap-2 mt-2">
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${
                    channel === 'telegram'
                      ? 'border-sky-200 bg-sky-50 text-sky-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  }`}
                  title="Canal da conversa"
                >
                  {channel === 'telegram' ? 'Telegram' : 'WhatsApp'}
                </span>
                {isBlocked && (
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold border border-red-200 bg-red-50 text-red-700"
                    title="Contacto bloqueado"
                  >
                    Bloqueado
                  </span>
                )}
                {conv.status === ConversationStatus.WAITING && <span className="w-2 h-2 rounded-full bg-yellow-400"></span>}
                {conv.unreadCount > 0 && (
                  <span className="px-1.5 py-0.5 bg-whatsapp-500 text-white text-[10px] rounded-full font-bold">
                    {conv.unreadCount}
                  </span>
                )}
                {conv.ownerId && conv.ownerId !== currentUserId && (
                  <img
                    src={owner?.avatarUrl}
                    className="w-4 h-4 rounded-full ml-auto object-cover"
                    title={`Responsável: ${owner?.name}`}
                  />
                )}
              </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ConversationListPanel;
