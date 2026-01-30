import React, { useState } from 'react';
import { smartspaceService } from '../services/smartspace';
import './ChatWidget.css';

const ChatWidget = ({ email }) => {
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messageThreadId, setMessageThreadId] = useState(null); // Store thread ID for conversation continuity

  const toggleChat = () => setIsOpen(!isOpen);

  const pollForResponse = async (threadId) => {
    const maxRetries = 20;
    const interval = 3000;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await smartspaceService.getMessageStatus(threadId);

        let botText = null;
        if (response && response.data) {
          const outputs = Object.values(response.data);
          if (outputs.length > 0 && outputs[0] !== null && outputs[0] !== "") {
            botText = typeof outputs[0] === 'object' ? JSON.stringify(outputs[0]) : String(outputs[0]);
          }
        }

        if (botText) {
          return botText;
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, interval));
      } catch (error) {
        console.warn(`Polling error on attempt ${i + 1}:`, error);
        // If it's a transient error, keep polling. 
        // If it's a hard error, maybe wait longer.
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
    return null;
  };

  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMessage = { sender: 'user', text: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    const initialThreadId = messageThreadId; // Capture the thread ID before the call
    let currentThreadId = messageThreadId;
    let botText = null;

    try {
      // 1. Initial attempt to send chat
      const response = await smartspaceService.sendChat(input, messages, email, currentThreadId);

      if (response && response.messageThreadId) {
        currentThreadId = response.messageThreadId;
        setMessageThreadId(currentThreadId);
      }

      // Check if we already have the answer
      if (response && response.data) {
        const outputs = Object.values(response.data);
        if (outputs.length > 0 && outputs[0] !== null && outputs[0] !== "") {
          botText = typeof outputs[0] === 'object' ? JSON.stringify(outputs[0]) : String(outputs[0]);
        }
      }

      // 2. Poll ONLY if this was a consecutive message (initialThreadId was present)
      // and we don't have a response yet.
      if (!botText && initialThreadId && currentThreadId) {
        botText = await pollForResponse(currentThreadId);
      }

    } catch (error) {
      console.error("Chat error:", error);

      // 3. Try to extract server-sent error message
      let serverErrorMessage = null;
      if (error.response && error.response.data) {
        // Look for common error fields in the response body
        const errorData = error.response.data;
        serverErrorMessage = errorData.message || errorData.error || (typeof errorData === 'string' ? errorData : null);
      }

      // 4. Poll ONLY if this was a consecutive message and the initial request failed
      if (initialThreadId && currentThreadId) {
        botText = await pollForResponse(currentThreadId);
      }

      // If we couldn't get a response via polling and we have a server error message, use it
      if (!botText && serverErrorMessage) {
        botText = serverErrorMessage;
      }
    } finally {
      if (botText) {
        const botMessage = { sender: 'bot', text: botText };
        setMessages(prev => [...prev, botMessage]);
      } else {
        // Generic fallback if all else fails
        const fallbackMsg = initialThreadId ? "Service still processing or connection error. Please try again later." : "Error connect to service. Please check your connection.";
        setMessages(prev => [...prev, { sender: 'bot', text: fallbackMsg }]);
      }
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
