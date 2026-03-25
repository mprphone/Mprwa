import React from 'react';
import { Check, ChevronDown, Clock, User, Users } from 'lucide-react';
import { Conversation, ConversationStatus, Customer, User as UserType } from '../../types';

type ChatHeaderBarProps = {
  selectedConversation: Conversation | undefined;
  selectedCustomer: Customer | null;
  users: UserType[];
  currentUserId: string;
  onBack: () => void;
  onAssignConversation: (userId: string) => void;
  onStatusChange: (status: ConversationStatus) => void;
};

const ChatHeaderBar: React.FC<ChatHeaderBarProps> = ({
  selectedConversation,
  selectedCustomer,
  users,
  currentUserId,
  onBack,
  onAssignConversation,
  onStatusChange,
}) => {
  const owner = users.find((item) => item.id === selectedConversation?.ownerId);

  return (
    <div className="bg-white px-4 py-3 border-b border-gray-200 flex justify-between items-center shadow-sm">
      <div className="flex items-center gap-3">
        <button className="md:hidden" onClick={onBack}>
          ←
        </button>
        <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center text-gray-500">
          <User size={20} />
        </div>
        <div>
          <h3 className="font-semibold">{selectedCustomer?.name}</h3>
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-500">{selectedCustomer?.company}</p>
            {selectedCustomer?.type && (
              <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                {selectedCustomer.type}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative group hidden lg:block">
          <button className="flex items-center gap-1 text-xs text-gray-600 bg-gray-50 px-3 py-1.5 rounded-full hover:bg-gray-100 border border-gray-200">
            <Users size={14} />
            {owner?.name || 'Não atribuído'}
            <ChevronDown size={12} />
          </button>
          <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg border border-gray-100 hidden group-hover:block z-10">
            <div className="py-1">
              <button
                onClick={() => onAssignConversation(currentUserId)}
                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                Atribuir a mim
              </button>
              <div className="border-t border-gray-100 my-1"></div>
              {users
                .filter((item) => item.id !== currentUserId)
                .map((user) => (
                  <button
                    key={user.id}
                    onClick={() => onAssignConversation(user.id)}
                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    {user.name}
                  </button>
                ))}
            </div>
          </div>
        </div>

        {selectedConversation?.status !== ConversationStatus.CLOSED ? (
          <>
            <button
              onClick={() => onStatusChange(ConversationStatus.WAITING)}
              title="Marcar como aguardando"
              className={`p-2 rounded-full hover:bg-gray-100 ${selectedConversation?.status === ConversationStatus.WAITING ? 'text-yellow-600' : 'text-gray-500'}`}
            >
              <Clock size={20} />
            </button>
            <button
              onClick={() => onStatusChange(ConversationStatus.CLOSED)}
              title="Fechar conversa"
              className="p-2 rounded-full hover:bg-gray-100 text-gray-500 hover:text-green-600"
            >
              <Check size={20} />
            </button>
          </>
        ) : (
          <button
            onClick={() => onStatusChange(ConversationStatus.OPEN)}
            className="px-3 py-1 bg-gray-200 text-gray-700 rounded-md text-sm"
          >
            Reabrir
          </button>
        )}
      </div>
    </div>
  );
};

export default ChatHeaderBar;
