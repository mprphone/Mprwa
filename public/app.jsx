import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Send, RefreshCw, MessageSquare, Phone } from 'lucide-react';

function App() {
  const [messages, setMessages] = useState([]);
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);

  // Buscar mensagens
  const fetchMessages = async () => {
    try {
      const res = await fetch('/api/messages');
      const json = await res.json();
      if (json.data) setMessages(json.data);
    } catch (error) {
      console.error("Erro ao buscar mensagens:", error);
    }
  };

  // Polling a cada 3 segundos
  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, []);

  // Enviar mensagem
  const handleSend = async (e) => {
    e.preventDefault();
    if (!to || !body) return;
    setLoading(true);

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, message: body })
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

  return (
    <div className="max-w-4xl mx-auto p-4 h-full flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between mb-6 bg-white p-4 rounded-lg shadow-sm">
        <div className="flex items-center gap-2 text-whatsapp-700">
          <MessageSquare className="w-6 h-6" />
          <h1 className="text-xl font-bold">WhatsApp Manager</h1>
        </div>
        <button onClick={fetchMessages} className="p-2 hover:bg-gray-100 rounded-full transition">
          <RefreshCw className="w-5 h-5 text-gray-600" />
        </button>
      </header>

      {/* Lista de Mensagens */}
      <div className="flex-1 overflow-y-auto mb-4 space-y-3 p-2 scrollbar-hide">
        {messages.length === 0 ? (
          <div className="text-center text-gray-400 mt-10">Nenhuma mensagem recebida ainda.</div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="bg-white p-3 rounded-lg shadow-sm border-l-4 border-whatsapp-500">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span className="font-mono font-bold text-gray-700">{msg.from_number}</span>
                <div className="flex items-center gap-2">
                  {msg.status === 'replied' && (
                    <span className="bg-green-100 text-green-800 text-[10px] px-1.5 py-0.5 rounded border border-green-200">Respondido</span>
                  )}
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
              <p className="text-gray-800">{msg.body}</p>
            </div>
          ))
        )}
      </div>

      {/* Formulário de Envio */}
      <form onSubmit={handleSend} className="bg-white p-4 rounded-lg shadow-lg border border-gray-100">
        <div className="flex gap-2 mb-2">
            <div className="relative w-1/3">
                <Phone className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
                <input 
                    type="text" 
                    placeholder="55219..." 
                    className="w-full pl-9 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                    value={to} onChange={e => setTo(e.target.value)}
                />
            </div>
            <input 
                type="text" 
                placeholder="Digite sua mensagem..." 
                className="flex-1 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                value={body} onChange={e => setBody(e.target.value)}
            />
            <button 
                disabled={loading}
                className="bg-whatsapp-600 hover:bg-whatsapp-700 text-white px-6 py-2 rounded font-medium flex items-center gap-2 disabled:opacity-50 transition">
                {loading ? '...' : <Send className="w-4 h-4" />}
            </button>
        </div>
      </form>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);