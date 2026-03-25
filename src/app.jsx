import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Send, RefreshCw, MessageSquare, Phone, User, Edit2, Image as ImageIcon, FileText } from 'lucide-react';
import './index.css';

function App() {
  const [contacts, setContacts] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const messagesEndRef = useRef(null);

  // Buscar Contatos (Sidebar)
  const fetchContacts = async () => {
    try {
      const res = await fetch('/api/contacts');
      if (!res.ok) throw new Error('Falha API');
      const json = await res.json();
      if (json.data) setContacts(json.data);
      setIsOnline(true);
    } catch (error) {
      console.error("Erro contatos:", error);
      setIsOnline(false);
    }
  };

  // Buscar Mensagens do Contato Selecionado
  const fetchMessages = async () => {
    if (!selectedContact) return;
    try {
      const res = await fetch(`/api/messages?phone=${selectedContact}`);
      const json = await res.json();
      if (json.data) setMessages(json.data);
    } catch (error) {
      console.error("Erro mensagens:", error);
    }
  };

  // Scroll automático para o fim
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Polling (Atualiza contatos e mensagens)
  useEffect(() => {
    fetchContacts();
    fetchMessages();
    const interval = setInterval(() => {
      fetchContacts();
      fetchMessages();
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedContact]);

  // Enviar mensagem
  const handleSend = async (e, type = 'text') => {
    if (e) e.preventDefault();
    if (!selectedContact || (!body && type === 'text')) return;
    setLoading(true);

    try {
      const payload = { to: selectedContact };
      if (type === 'template') {
        payload.type = 'template';
      } else if (type === 'menu') {
        payload.type = 'menu';
      } else if (type === 'image' || type === 'document') {
        payload.type = type;
        payload.message = body; // Aqui o 'body' será a URL
      } else {
        payload.type = 'text';
        payload.message = body;
      }

      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setBody('');
        fetchMessages(); // Atualiza lista
      } else {
        alert('Erro ao enviar: ' + JSON.stringify(data));
      }
    } catch (err) {
      alert('Erro de conexão');
    } finally {
      setLoading(false);
    }
  };

  // Editar Nome do Contato
  const handleEditName = async () => {
    if (!selectedContact) return;
    const currentContact = contacts.find(c => c.from_number === selectedContact);
    const newName = prompt("Nome do Cliente:", currentContact?.name || "");
    if (newName !== null) {
        await fetch('/api/contacts/name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: selectedContact, name: newName })
        });
        fetchContacts();
    }
  };

  // Handler auxiliar para pedir URL
  const handleMediaSend = (mediaType) => {
    const url = prompt(`Insira o link público do ${mediaType === 'image' ? 'imagem' : 'documento'}:`);
    if (url) {
        setBody(url); // Usa o state body temporariamente para guardar a URL
        // Precisamos chamar o handleSend mas o state body ainda não atualizou neste ciclo.
        // Vamos forçar passando o valor direto se refatorarmos, mas para MVP rápido:
        // O ideal é chamar handleSend passando a URL como argumento, mas vamos simplificar:
        // Vamos fazer um fetch direto aqui para não depender do state assíncrono
        fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: selectedContact, type: mediaType, message: url })
        }).then(res => res.json()).then(data => {
            if(data.success) { fetchMessages(); }
            else { alert('Erro: ' + JSON.stringify(data)); }
        });
    }
  };

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      
      {/* Sidebar: Lista de Contatos */}
      <div className="w-1/3 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 bg-gray-50 border-b flex justify-between items-center">
          <h2 className="font-bold text-lg text-gray-700">Conversas</h2>
          <div className={`w-3 h-3 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`} title={isOnline ? "Online" : "Offline"}></div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {contacts.length === 0 && (
            <div className="p-4 text-center text-gray-500 text-sm mt-4">
              Nenhuma conversa encontrada.<br/>
              Envie uma mensagem para o número do bot para iniciar.
            </div>
          )}
          {contacts.map(contact => (
            <div 
              key={contact.from_number}
              onClick={() => setSelectedContact(contact.from_number)}
              className={`p-4 border-b cursor-pointer hover:bg-gray-50 transition ${selectedContact === contact.from_number ? 'bg-green-50 border-l-4 border-green-500' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className="bg-gray-200 p-2 rounded-full"><User className="w-5 h-5 text-gray-500" /></div>
                <div>
                  <p className="font-semibold text-gray-800">{contact.name || contact.from_number}</p>
                  {contact.name && (
                    <p className="text-xs text-gray-500">{contact.from_number}</p>
                  )}
                  <p className="text-xs text-gray-500">{new Date(contact.last_msg_time).toLocaleString()}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Área de Chat */}
      <div className="flex-1 flex flex-col bg-[#e5ded8]">
        {selectedContact ? (
          <>
            {/* Header do Chat */}
            <div className="p-4 bg-gray-100 border-b flex items-center gap-3 shadow-sm cursor-pointer hover:bg-gray-200 transition" onClick={handleEditName} title="Clique para editar o nome">
              <User className="w-6 h-6 text-gray-600" />
              <div>
                <h3 className="font-bold text-gray-800">
                  {contacts.find(c => c.from_number === selectedContact)?.name || selectedContact}
                </h3>
                <p className="text-xs text-gray-500 flex items-center gap-1">Clique para editar nome <Edit2 className="w-3 h-3" /></p>
              </div>
            </div>

            {/* Mensagens */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`p-3 rounded-lg shadow max-w-[70%] ${msg.direction === 'outbound' ? 'bg-[#d9fdd3]' : 'bg-white'}`}>
                    <p className="text-gray-800 text-sm whitespace-pre-wrap">{msg.body}</p>
                    <div className="text-[10px] text-gray-500 text-right mt-1">
                      {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-3 bg-gray-100">
              <form onSubmit={handleSend} className="flex gap-2">
                <button
                    type="button"
                    onClick={() => handleSend(null, 'menu')}
                    className="bg-purple-100 text-purple-600 px-3 rounded hover:bg-purple-200 text-xs font-bold"
                    title="Enviar Menu Bot"
                >
                    Menu
                </button>
                <button
                    type="button"
                    onClick={() => handleMediaSend('image')}
                    className="bg-gray-200 text-gray-600 px-2 rounded hover:bg-gray-300"
                    title="Enviar Imagem (URL)"
                >
                    <ImageIcon className="w-4 h-4" />
                </button>
                <button
                    type="button"
                    onClick={() => handleMediaSend('document')}
                    className="bg-gray-200 text-gray-600 px-2 rounded hover:bg-gray-300"
                    title="Enviar Documento (URL)"
                >
                    <FileText className="w-4 h-4" />
                </button>
                <button
                    type="button"
                    onClick={() => handleSend(null, 'template')}
                    className="bg-blue-100 text-blue-600 px-3 rounded hover:bg-blue-200 text-xs font-bold"
                    title="Enviar Template"
                >
                    TPL
                </button>
                <input 
                type="text" 
                placeholder="Digite sua mensagem..." 
                  className="flex-1 p-2 border rounded-full focus:outline-none focus:ring-2 focus:ring-green-500"
                value={body} onChange={e => setBody(e.target.value)}
                />
                <button 
                  disabled={loading}
                  className="bg-green-600 hover:bg-green-700 text-white p-2 rounded-full disabled:opacity-50 transition">
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 flex-col">
            <MessageSquare className="w-16 h-16 mb-4 opacity-20" />
            <p>Selecione uma conversa para começar</p>
          </div>
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);