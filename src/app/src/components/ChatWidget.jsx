import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { smartspaceService } from "../services/smartspace";
import "./ChatWidget.css";

const ChatWidget = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messageThreadId, setMessageThreadId] = useState(null);

  // Track the last bot message ID we've displayed
  const lastBotMessageId = useRef(null);
  // Prevent concurrent sends
  const isSending = useRef(false);
  // Track polling abort
  const abortPolling = useRef(false);

  const chatBodyRef = useRef(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
    }
  }, [messages, loading]);

  /**
   * Parse the bot response from the proxy data
   * Returns { text, messageId } or null
   */
  const parseBotResponse = (response) => {
    console.log("[Widget] Proxy Data Received:", response);

    if (!response || !response.data || response.data.length === 0) {
      return null;
    }

    const values = Array.isArray(response.data)
      ? response.data
      : Object.values(response.data);

    // Find the Response output value
    const botEntry = values.find(
      (v) =>
        v.name === "Response" &&
        (v.type === "Output" || String(v.type) === "2"),
    );

    if (!botEntry || !botEntry.value) {
      return null;
    }

    const val = botEntry.value;
    let text = null;

    // Handle array values (extract meaningful text)
    if (Array.isArray(val)) {
      const meaningfulText = val.filter(
        (s) => typeof s === "string" && s.trim().length > 20,
      );
      text =
        meaningfulText.length > 0
          ? meaningfulText[meaningfulText.length - 1]
          : val[0] || null;
    } else {
      text = String(val);
    }

    if (!text) {
      return null;
    }

    // Return both text and the message ID from the response
    return {
      text: text.trim(),
      messageId: response.messageId || botEntry.id || null,
    };
  };

  /**
   * Poll for the bot's response
   * Stops early if a new message is sent or max attempts reached
   */
  const pollForResponse = async (threadId, sentTime, maxAttempts = 40) => {
    console.log(`[Widget] Starting poll for thread ${threadId}`);

    for (let i = 0; i < maxAttempts; i++) {
      // Check if polling should be aborted
      if (abortPolling.current) {
        console.log("[Widget] Polling aborted by new message");
        return null;
      }

      try {
        // Wait before polling (except first attempt)
        if (i > 0) {
          // Faster polling for first 5 attempts (1.5s), then 3s
          const delay = i <= 5 ? 1500 : 3000;
          await new Promise((res) => setTimeout(res, delay));
        }

        // Check abort again after delay
        if (abortPolling.current) {
          console.log("[Widget] Polling aborted during delay");
          return null;
        }

        // Make the status request with the last message ID we've seen
        const response = await smartspaceService.getMessageStatus(
          threadId,
          sentTime,
          lastBotMessageId.current,
        );

        console.log(
          `[Widget] POLL ${i}: Status=${response.status}, DataLength=${response.data?.length || 0}`,
        );

        // Parse the response
        const result = parseBotResponse(response);

        if (result && result.text) {
          // Check if this is a new message ID
          if (
            result.messageId &&
            result.messageId !== lastBotMessageId.current
          ) {
            console.log(`[Widget] New message found: ${result.messageId}`);
            lastBotMessageId.current = result.messageId;
            return result.text;
          }

          // If we got text but no new message ID, and status is completed, assume it's new
          if (!result.messageId && response.status === "completed") {
            console.log("[Widget] Message found (no ID), assuming new");
            return result.text;
          }

          console.log("[Widget] Message already displayed, continuing poll");
        }

        // If status indicates we should stop polling
        if (response.status === "stale" || response.status === "no_response") {
          console.log(`[Widget] Stopping poll: ${response.status}`);
          return null;
        }

        // If we got an error status but should retry
        if (response.status === "error_retry") {
          console.warn(`[Widget] Error on poll ${i}, retrying...`);
          continue;
        }
      } catch (err) {
        console.warn(`[Widget] Polling attempt ${i} failed:`, err.message);

        // Stop on certain errors
        if (err.response && [401, 403, 404].includes(err.response.status)) {
          console.error("[Widget] Unrecoverable error, stopping poll");
          return null;
        }

        // Continue polling on other errors
        await new Promise((res) => setTimeout(res, 3000));
      }
    }

    console.warn("[Widget] Polling timeout reached (40 attempts)");
    return null;
  };

  /**
   * Send a message to the chat
   */
  const sendMessage = async () => {
    // Validation
    if (!input.trim() || loading || isSending.current) {
      console.log("[Widget] Send blocked:", {
        loading,
        isSending: isSending.current,
      });
      return;
    }

    // Lock to prevent concurrent sends
    isSending.current = true;
    abortPolling.current = true;

    const sentTime = new Date().toISOString();
    const currentInput = input.trim();
    const userMessage = { sender: "user", text: currentInput };
    const isFirstMessage = !messageThreadId;

    // Optimistic UI update
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    // Reset abort flag after a brief moment
    setTimeout(() => {
      abortPolling.current = false;
    }, 100);

    let currentThreadId = messageThreadId;
    let botText = null;

    try {
      console.log(
        `[Widget] Sending message (first=${isFirstMessage}): "${currentInput}"`,
      );

      // Send the chat message
      const response = await smartspaceService.sendChat(
        currentInput,
        [],
        currentThreadId,
      );

      console.log("[Widget] Chat response received:", response);

      // Handle different response statuses
      if (response.success === false) {
        // Backend returned an error (first message timeout with no thread found)
        console.error("[Widget] Backend returned error:", response);
        botText =
          response.message ||
          "I'm having trouble connecting. Please try again.";
      } else {
        // Update thread ID if we got one
        if (response?.messageThreadId) {
          currentThreadId = response.messageThreadId;
          setMessageThreadId(currentThreadId);
        }

        // Check if we should poll
        if (currentThreadId && response.success) {
          console.log(
            `[Widget] Starting polling with status: ${response.status}`,
          );
          botText = await pollForResponse(currentThreadId, sentTime);
        }
      }
    } catch (err) {
      console.error("[Widget] Chat send error:", err);

      // Check if response contains a thread ID despite the error
      const responseThreadId = err.response?.data?.messageThreadId;

      if (responseThreadId) {
        console.log(
          "[Widget] Found thread ID in error response, attempting poll",
        );
        currentThreadId = responseThreadId;
        setMessageThreadId(currentThreadId);
        botText = await pollForResponse(currentThreadId, sentTime, 15);
      } else {
        // Attempt recovery polling only if we already have a thread
        const isServerError = err.response && err.response.status >= 500;
        const shouldRetry = currentThreadId && (isServerError || !err.response);

        if (shouldRetry) {
          console.log("[Widget] Attempting recovery poll after error");
          botText = await pollForResponse(currentThreadId, sentTime, 15);
        }
      }
    } finally {
      // Always show a response
      const finalBotMsg =
        botText || "I'm having trouble connecting. Please try again later.";

      setMessages((prev) => [...prev, { sender: "bot", text: finalBotMsg }]);
      setLoading(false);
      isSending.current = false;
    }
  };

  /**
   * Handle Enter key press
   */
  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-widget-container always-open">
      <div className="chat-window">
        <div className="chat-header"></div>
        <div className="chat-body" ref={chatBodyRef}>
          {messages.map((msg, idx) => (
            <div key={idx} className={`chat-message ${msg.sender}`}>
              {msg.sender === "bot" ? (
                <div style={{ textAlign: "left", width: "100%" }}>
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                </div>
              ) : (
                msg.text
              )}
            </div>
          ))}
          {loading && <div className="loading">Typing...</div>}
        </div>

        <div className="chat-input-area">
          <input
            type="text"
            value={input}
            disabled={loading}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask anything"
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatWidget;
