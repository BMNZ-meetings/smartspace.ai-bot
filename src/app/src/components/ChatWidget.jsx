import React, { useState } from 'react';
import { smartspaceService } from '../services/smartspace';
import './ChatWidget.css';

const ChatWidget = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const toggleChat = () => setIsOpen(!isOpen);

  const sendMessage = async () => {
    if (!input.trim()) return;
    
    const userMessage = { sender: 'user', text: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await smartspaceService.sendChat(input, messages);
      
      // Parse response from our proxy which returns { success: true, data: { ... }, fullResponse: ... }
      // We look for the first text output from Smartspace
      let botText = "No response text found.";
      if (response && response.data) {
          const outputs = Object.values(response.data);
          if (outputs.length > 0) {
              // Try to find a string or array of strings (smartspace sometimes returns complex values?)
              // The python script expects simple values. We'll take the first one.
              botText = typeof outputs[0] === 'object' ? JSON.stringify(outputs[0]) : String(outputs[0]);
          } else if (response.fullResponse) {
               // Fallback
               botText = "Received empty response from Smartspace.";
          }
      } else if (response && response.message) {
           // Fallback for mock/error modes
           botText = response.message;
      }

      const botMessage = { sender: 'bot', text: botText };
      setMessages(prev => [...prev, botMessage]);
    } catch (error) {
      console.error("Chat error:", error);
      setMessages(prev => [...prev, { sender: 'bot', text: "Error connecting to service." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-widget-container">
      <button className="chat-toggle-btn" onClick={toggleChat}>
        {isOpen ? 'Close' : 'Chat'}
      </button>

      {isOpen && (
        <div className="chat-window">
          <div className="chat-header">Smartspace Chat</div>
          <div className="chat-body">
            {messages.map((msg, idx) => (
              <div key={idx} className={`chat-message ${msg.sender}`}>
                {msg.text}
              </div>
            ))}
            {loading && <div className="loading">Typing...</div>}
          </div>
          <div className="chat-input-area">
            <input 
              type="text" 
              value={input} 
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
              placeholder="Type a message..."
            />
            <button onClick={sendMessage}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatWidget;
