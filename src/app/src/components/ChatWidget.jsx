import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { smartspaceService } from "../services/smartspace";
import "./ChatWidget.css";

function isDiagramLine(line) {
  // Unicode box-drawing characters
  if (/[┌┐└┘│─├┤┬┴┼╔╗╚╝║═]/.test(line)) return true;
  // Unicode arrows as standalone lines
  if (/^\s*[↓↑→←]\s*$/.test(line)) return true;
  // ASCII standalone connectors: | or v
  if (/^\s*[|]\s*$/.test(line)) return true;
  if (/^\s*v\s*$/.test(line)) return true;
  // ASCII box borders: +---- or ----+
  if (/[+][-]{3,}|[-]{3,}[+]/.test(line)) return true;
  // Separator lines: ====
  if (/[=]{4,}/.test(line)) return true;
  return false;
}

function preprocessMarkdown(text) {
  const lines = text.split("\n");
  const result = [];
  let inCodeBlock = false;
  let buffer = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isDiagramLine(line)) {
      if (!inCodeBlock) {
        result.push("```");
        inCodeBlock = true;
      }
      result.push(...buffer);
      buffer = [];
      result.push(line);
    } else if (inCodeBlock) {
      buffer.push(line);
      // Look ahead: is there more diagram within the next 5 lines?
      let moreDiagram = false;
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
        if (isDiagramLine(lines[j])) {
          moreDiagram = true;
          break;
        }
      }
      if (!moreDiagram) {
        result.push("```");
        inCodeBlock = false;
        result.push(...buffer);
        buffer = [];
      }
    } else {
      result.push(line);
    }
  }

  if (inCodeBlock) {
    result.push("```");
    result.push(...buffer);
  }

  return result.join("\n");
}

const ChatWidget = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messageThreadId, setMessageThreadId] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("idle"); // idle | online | error

  // Track the last bot message ID we've displayed
  const lastBotMessageId = useRef(null);
  // Prevent concurrent sends
  const isSending = useRef(false);
  // Track polling abort
  const abortPolling = useRef(false);

  const chatBodyRef = useRef(null);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const hasScrolledIntoView = useRef(false);

  // Scroll the chat widget into view when it first expands
  useEffect(() => {
    if ((messages.length > 0 || loading) && !hasScrolledIntoView.current) {
      hasScrolledIntoView.current = true;
      // Wait for the CSS height transition to start
      setTimeout(() => {
        containerRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 100);
    }
  }, [messages, loading]);

  // Smooth auto-scroll to bottom
  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTo({
        top: chatBodyRef.current.scrollHeight,
        behavior: "smooth",
      });
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
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    // Reset abort flag after a brief moment
    setTimeout(() => {
      abortPolling.current = false;
    }, 100);

    let currentThreadId = messageThreadId;
    let botText = null;
    let isError = false;

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
        isError = true;
        setConnectionStatus("error");
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

      // Handle rate limiting
      if (err.response?.status === 429) {
        isError = true;
        setConnectionStatus("error");
        botText =
          err.response?.data?.message ||
          "Too many messages. Please wait a moment before trying again.";
        return;
      }

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
      if (!botText) {
        isError = true;
      }

      setConnectionStatus(isError ? "error" : "online");

      const finalBotMsg =
        botText || "I'm having trouble connecting. Please try again later.";

      setMessages((prev) => [
        ...prev,
        { sender: "bot", text: finalBotMsg, isError },
      ]);
      setLoading(false);
      isSending.current = false;
    }
  };

  /**
   * Copy bot message text to clipboard
   */
  const copyToClipboard = async (text, idx) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch (err) {
      console.error("[Widget] Copy failed:", err);
    }
  };

  /**
   * Auto-grow textarea as user types
   */
  const handleInputChange = (e) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  /**
   * Handle Enter key press
   */
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-widget-container always-open" ref={containerRef}>
      <div className={`chat-window${messages.length > 0 || loading ? ' chat-expanded' : ''}`}>
        <div className="chat-header"><span className={`status-dot ${connectionStatus}`}></span></div>
        <div className="chat-body" ref={chatBodyRef} role="log" aria-live="polite">
          {messages.map((msg, idx) => (
            <div key={idx} className={`chat-message ${msg.sender}${msg.isError ? ' error' : ''}`}>
              {msg.sender === "bot" ? (
                <>
                <button
                  className={`copy-btn${copiedIdx === idx ? ' copied' : ''}`}
                  onClick={() => copyToClipboard(msg.text, idx)}
                  aria-label="Copy message"
                >
                  {copiedIdx === idx ? (
                    "✓"
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  )}
                </button>
                <div style={{ textAlign: "left", width: "100%" }}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {preprocessMarkdown(msg.text)}
                  </ReactMarkdown>
                </div>
                </>
              ) : (
                msg.text
              )}
            </div>
          ))}
          {loading && (
            <div className="loading">
              <span className="dot"></span>
              <span className="dot"></span>
              <span className="dot"></span>
            </div>
          )}
        </div>

        <div className="chat-input-area">
          <textarea
            ref={inputRef}
            value={input}
            disabled={loading}
            maxLength={5000}
            rows={1}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything"
            autoFocus
            aria-label="Type your message"
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            aria-label="Send message"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatWidget;
