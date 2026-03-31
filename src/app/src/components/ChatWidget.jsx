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
  const [pending, setPending] = useState(false); // true when waiting for any response (blocks new sends)
  const [messageThreadId, setMessageThreadId] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("idle"); // idle | online | error
  const [showToast, setShowToast] = useState(false);

  // History panel state - restore open preference from localStorage
  const [historyOpen, setHistoryOpen] = useState(() => {
    try { return localStorage.getItem("dm_history_open") === "true"; } catch { return false; }
  });
  const [historyThreads, setHistoryThreads] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyAvailable, setHistoryAvailable] = useState(false);
  const [viewingThread, setViewingThread] = useState(null); // threadId of loaded history
  const [threadLoading, setThreadLoading] = useState(false);

  // In-memory cache for loaded thread messages (cleared on page unload)
  const threadCache = useRef(new Map());

  // Track the last bot message ID we've displayed
  const lastBotMessageId = useRef(null);
  // Prevent concurrent sends
  const isSending = useRef(false);
  // Generation counter: each operation that takes ownership of the chat view increments this.
  // Any async operation checks its captured generation against the current value before writing state.
  const operationGen = useRef(0);

  const chatBodyRef = useRef(null);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const hasScrolledIntoView = useRef(false);

  // Load history on mount
  useEffect(() => {
    const loadHistory = async () => {
      setHistoryLoading(true);
      const result = await smartspaceService.getHistory();
      if (result.success && result.threads && result.threads.length > 0) {
        setHistoryThreads(result.threads);
        setHistoryAvailable(true);
      } else {
        // No threads - close panel even if localStorage said open
        setHistoryOpen(false);
      }
      setHistoryLoading(false);
    };
    loadHistory();
  }, []);

  /**
   * Toggle history panel - data is loaded on mount, toggle is instant
   */
  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    try { localStorage.setItem("dm_history_open", String(next)); } catch { /* ignore */ }
  };

  /**
   * Load a historical thread into the chat view
   */
  const loadThread = async (threadId) => {
    // Claim a new generation - invalidates any in-flight operation
    const myGen = ++operationGen.current;
    setLoading(false);

    // Check in-memory cache first
    const cached = threadCache.current.get(threadId);
    if (cached) {
      setMessages(cached);
      setMessageThreadId(threadId);
      setViewingThread(threadId);
      lastBotMessageId.current = null;
      setConnectionStatus("online");
      return;
    }

    setThreadLoading(true);
    setMessages([]);
    try {
      const result = await smartspaceService.getThread(threadId);

      // Staleness check: user may have navigated away during the fetch
      if (operationGen.current !== myGen) return;

      if (result.success && result.messages) {
        const loadedMessages = result.messages.map(m => ({
          sender: m.sender,
          text: m.text,
          isError: false,
        }));
        setMessages(loadedMessages);
        setMessageThreadId(threadId);
        setViewingThread(threadId);
        lastBotMessageId.current = null;
        setConnectionStatus("online");
        setThreadLoading(false);

        // If the last message is from the user, the bot hasn't responded yet - resume polling
        const lastMsg = loadedMessages[loadedMessages.length - 1];
        if (lastMsg && lastMsg.sender === "user") {
          console.log(`[Widget] Thread ${threadId} has unanswered message - resuming poll`);
          setLoading(true);
          const lastUserTime = result.messages[result.messages.length - 1]?.date || new Date().toISOString();
          const botText = await pollForResponse(threadId, lastUserTime, myGen);

          // Staleness check after poll
          if (operationGen.current !== myGen) return;

          if (botText) {
            const updated = [...loadedMessages, { sender: "bot", text: botText, isError: false }];
            setMessages(updated);
            threadCache.current.set(threadId, updated);
          } else {
            setMessages((prev) => [...prev, {
              sender: "bot",
              text: "The response for this conversation is no longer available. Please start a new conversation.",
              isError: true,
            }]);
          }
          setLoading(false);
          setConnectionStatus(botText ? "online" : "error");
        } else {
          // Cache completed threads
          threadCache.current.set(threadId, loadedMessages);
        }
        return;
      }
    } catch (err) {
      if (operationGen.current !== myGen) return;
      console.error("[Widget] Failed to load thread:", err);
      setMessages([{ sender: "bot", text: "Could not load this conversation. Please try again.", isError: true }]);
      setConnectionStatus("error");
    }
    setThreadLoading(false);
  };

  /**
   * Start a new conversation (clear history view)
   */
  const startNewConversation = () => {
    // Claim a new generation - invalidates any in-flight operation
    ++operationGen.current;
    setLoading(false);

    setMessages([]);
    setMessageThreadId(null);
    setViewingThread(null);
    lastBotMessageId.current = null;
    setConnectionStatus("idle");
  };

  /**
   * Format a date string for display
   */
  const formatDate = (dateStr) => {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dateStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diffDays = Math.round((todayStart - dateStart) / (1000 * 60 * 60 * 24));

      if (diffDays === 0) return "Today";
      if (diffDays === 1) return "Yesterday";
      if (diffDays < 7) return `${diffDays} days ago`;

      return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return "";
    }
  };

  /**
   * Get messages for a thread - reuse from state if already loaded, otherwise fetch
   */
  const getThreadMessages = async (threadId) => {
    // Check current view first
    if (viewingThread === threadId && messages.length > 0) {
      return messages;
    }
    // Check cache
    const cached = threadCache.current.get(threadId);
    if (cached) return cached;
    // Fetch from API
    const result = await smartspaceService.getThread(threadId);
    if (result.success && result.messages) {
      const parsed = result.messages.map(m => ({ sender: m.sender, text: m.text, isError: false }));
      threadCache.current.set(threadId, parsed);
      return parsed;
    }
    return null;
  };

  /**
   * Format messages as plain text for export
   */
  const formatMessages = (msgs) => {
    return msgs.map(m => {
      const sender = m.sender === "user" ? "You" : "Digital Mentor";
      return `${sender}:\n${m.text}`;
    }).join("\n\n---\n\n");
  };

  /**
   * Copy a single thread's conversation to clipboard
   */
  const [historyActionLoading, setHistoryActionLoading] = useState(null);

  const copyThread = async (threadId, e) => {
    e.stopPropagation();
    setHistoryActionLoading(threadId);
    try {
      const msgs = await getThreadMessages(threadId);
      if (msgs) {
        await navigator.clipboard.writeText(formatMessages(msgs));
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2500);
      }
    } catch (err) {
      console.error("[Widget] Copy thread failed:", err);
    }
    setHistoryActionLoading(null);
  };

  /**
   * Download a single thread as TXT
   */
  const downloadThread = async (threadId, firstPrompt, e) => {
    e.stopPropagation();
    setHistoryActionLoading(threadId);
    try {
      const msgs = await getThreadMessages(threadId);
      if (msgs) {
        const blob = new Blob([formatMessages(msgs)], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const slug = (firstPrompt || "conversation").substring(0, 30).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
        a.download = `digital-mentor-${slug}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("[Widget] Download thread failed:", err);
    }
    setHistoryActionLoading(null);
  };

  /**
   * Delete a thread - confirmation modal + HubSpot removal
   */
  const [deleteConfirm, setDeleteConfirm] = useState(null); // threadId pending confirmation

  const requestDeleteThread = (threadId, e) => {
    e.stopPropagation();
    setDeleteConfirm(threadId);
  };

  const confirmDeleteThread = async () => {
    const threadId = deleteConfirm;
    setDeleteConfirm(null);
    if (!threadId) return;

    setHistoryActionLoading(threadId);
    try {
      const result = await smartspaceService.deleteThread(threadId);
      if (result.success) {
        // Remove from history list
        setHistoryThreads((prev) => prev.filter(t => t.threadId !== threadId));
        // Remove from cache
        threadCache.current.delete(threadId);
        // If currently viewing this thread, clear the view
        if (viewingThread === threadId) {
          setMessages([]);
          setMessageThreadId(null);
          setViewingThread(null);
          setConnectionStatus("idle");
        }
        // If no threads left, hide the history icon
        setHistoryThreads((prev) => {
          if (prev.length === 0) setHistoryAvailable(false);
          return prev;
        });
      }
    } catch (err) {
      console.error("[Widget] Delete thread failed:", err);
    }
    setHistoryActionLoading(null);
  };

  // Scroll the chat widget into view when it expands or history opens
  useEffect(() => {
    if ((messages.length > 0 || loading || historyOpen) && !hasScrolledIntoView.current) {
      hasScrolledIntoView.current = true;
      setTimeout(() => {
        containerRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 100);
    }
  }, [messages, loading, historyOpen]);

  // Re-centre when history panel toggles
  useEffect(() => {
    if (historyOpen) {
      setTimeout(() => {
        containerRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 250); // After panel animation
    }
  }, [historyOpen]);

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
  const pollForResponse = async (threadId, sentTime, gen, maxAttempts = 40) => {
    console.log(`[Widget] Starting poll for thread ${threadId} (gen=${gen})`);

    for (let i = 0; i < maxAttempts; i++) {
      // Check if this operation has been superseded
      if (operationGen.current !== gen) {
        console.log(`[Widget] Poll aborted - gen ${gen} superseded by ${operationGen.current}`);
        return null;
      }

      try {
        // Wait before polling (except first attempt)
        if (i > 0) {
          const delay = i <= 5 ? 1500 : 3000;
          await new Promise((res) => setTimeout(res, delay));
        }

        // Check again after delay
        if (operationGen.current !== gen) {
          console.log(`[Widget] Poll aborted during delay - gen ${gen} superseded`);
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
    if (!input.trim() || loading || isSending.current || pending) {
      return;
    }

    // Lock and claim generation
    isSending.current = true;
    setPending(true);
    const myGen = ++operationGen.current;

    const sentTime = new Date().toISOString();
    const currentInput = input.trim();
    const userMessage = { sender: "user", text: currentInput };
    const isFirstMessage = !messageThreadId;

    // Clear history view state if starting a new conversation
    if (isFirstMessage) {
      setViewingThread(null);
    }

    // Optimistic UI update
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    let currentThreadId = messageThreadId;
    let botText = null;
    let isError = false;

    try {
      console.log(`[Widget] Sending (first=${isFirstMessage}, thread=${currentThreadId || 'new'}, gen=${myGen})`);

      const response = await smartspaceService.sendChat(
        currentInput,
        [],
        currentThreadId,
      );

      console.log(`[Widget] Response (status=${response?.status}, thread=${response?.messageThreadId})`);

      // Handle different response statuses
      if (response.success === false) {
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

          // Immediately add to history panel so it's visible while polling
          if (isFirstMessage) {
            setHistoryThreads((prev) => {
              if (prev.some(t => t.threadId === currentThreadId)) return prev;
              return [{
                threadId: currentThreadId,
                firstPrompt: currentInput.substring(0, 120),
                date: new Date().toISOString(),
              }, ...prev];
            });
            setHistoryAvailable(true);
            setViewingThread(currentThreadId);
          }
        }

        // Poll for response - pass generation for staleness checks
        if (currentThreadId && response.success) {
          console.log(`[Widget] Starting poll (gen=${myGen})`);
          botText = await pollForResponse(currentThreadId, sentTime, myGen);
        }
      }
    } catch (err) {
      console.error("[Widget] Chat send error:", err);

      if (err.response?.status === 429) {
        isError = true;
        setConnectionStatus("error");
        botText =
          err.response?.data?.message ||
          "Too many messages. Please wait a moment before trying again.";
      } else {
        const responseThreadId = err.response?.data?.messageThreadId;

        if (responseThreadId) {
          currentThreadId = responseThreadId;
          setMessageThreadId(currentThreadId);
          botText = await pollForResponse(currentThreadId, sentTime, myGen, 15);
        } else {
          const isServerError = err.response && err.response.status >= 500;
          const shouldRetry = currentThreadId && (isServerError || !err.response);

          if (shouldRetry) {
            botText = await pollForResponse(currentThreadId, sentTime, myGen, 15);
          }
        }
      }
    } finally {
      // If this operation has been superseded, don't touch the UI
      if (operationGen.current !== myGen) {
        isSending.current = false;
        setPending(false);
        return;
      }

      if (!botText) {
        isError = true;
      }

      setConnectionStatus(isError ? "error" : "online");

      const finalBotMsg =
        botText || "I'm having trouble connecting. Please try again later.";

      setMessages((prev) => [...prev, { sender: "bot", text: finalBotMsg, isError }]);

      // Cache separately to avoid capturing wrong thread's messages
      if (currentThreadId && botText && !isError) {
        threadCache.current.delete(currentThreadId);
      }

      setLoading(false);
      isSending.current = false;
      setPending(false);
    }
  };

  /**
   * Copy bot message text to clipboard
   */
  const copyToClipboard = async (text, idx) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2500);
    } catch (err) {
      console.error("[Widget] Copy failed:", err);
    }
  };

  /**
   * Format all messages as plain text
   */
  const formatConversation = () => {
    return messages.map(msg => {
      const sender = msg.sender === 'user' ? 'You' : 'Digital Mentor';
      return `${sender}:\n${msg.text}`;
    }).join('\n\n---\n\n');
  };

  /**
   * Copy entire conversation to clipboard
   */
  const copyConversation = async () => {
    try {
      await navigator.clipboard.writeText(formatConversation());
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2500);
    } catch (err) {
      console.error('[Widget] Copy conversation failed:', err);
    }
  };

  /**
   * Download conversation as a TXT file
   */
  const downloadConversation = () => {
    const blob = new Blob([formatConversation()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `digital-mentor-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
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
    <div className={`chat-widget-container always-open${historyOpen ? ' history-open' : ''}`} ref={containerRef}>
      {/* History Panel */}
      {historyOpen && (
        <div className="history-panel">
          <div className="history-panel-header">
            <span className="history-panel-title">Conversations</span>
            <button className="history-panel-close" onClick={() => { setHistoryOpen(false); try { localStorage.setItem("dm_history_open", "false"); } catch {} }} aria-label="Close history">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <button className="history-new-btn" onClick={startNewConversation} disabled={pending}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            {pending ? "Waiting for response..." : "New conversation"}
          </button>
          <div className="history-list">
            {historyLoading ? (
              <div className="history-loading">Loading...</div>
            ) : historyThreads.length === 0 ? (
              <div className="history-empty">No previous conversations</div>
            ) : (
              historyThreads.map((thread) => (
                <div
                  key={thread.threadId}
                  className={`history-item${viewingThread === thread.threadId ? ' active' : ''}`}
                  onClick={() => loadThread(thread.threadId)}
                >
                  <div className="history-item-prompt">{thread.firstPrompt}</div>
                  <div className="history-item-meta">
                    <span className="history-item-date">{formatDate(thread.date)}</span>
                    <div className="history-item-actions">
                      {historyActionLoading === thread.threadId ? (
                        <span className="history-item-spinner">...</span>
                      ) : (
                        <>
                          <button className="history-item-btn" onClick={(e) => copyThread(thread.threadId, e)} aria-label="Copy conversation">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                          </button>
                          <button className="history-item-btn" onClick={(e) => downloadThread(thread.threadId, thread.firstPrompt, e)} aria-label="Download conversation">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                          </button>
                          <button className="history-item-btn delete" onClick={(e) => requestDeleteThread(thread.threadId, e)} aria-label="Delete conversation">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="delete-modal-backdrop" onClick={() => setDeleteConfirm(null)}>
          <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
            <p className="delete-modal-text">Remove this conversation from your history? This cannot be undone.</p>
            <div className="delete-modal-actions">
              <button className="delete-modal-btn cancel" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="delete-modal-btn confirm" onClick={confirmDeleteThread}>Remove</button>
            </div>
          </div>
        </div>
      )}

      <div className={`chat-window${messages.length > 0 || loading || threadLoading ? ' chat-expanded' : ''}`}>
        <div className="chat-header">
          <div className="chat-header-left">
            <span className={`status-dot ${connectionStatus}`}></span>
            {historyAvailable && (
              <button className={`chat-header-btn history-toggle${historyOpen ? ' active' : ''}`} onClick={toggleHistory} aria-label="Conversation history" title="Conversation history">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
              </button>
            )}
          </div>
          <div className="chat-header-actions">
            {viewingThread && (
              <button className="chat-header-btn" onClick={startNewConversation} disabled={pending} aria-label="New conversation" title="New conversation">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
            )}
            {messages.length > 0 && (
              <>
                <button className="chat-header-btn" onClick={copyConversation} aria-label="Copy conversation" title="Copy conversation">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                </button>
                <button className="chat-header-btn" onClick={downloadConversation} aria-label="Download conversation" title="Download conversation">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
              </>
            )}
          </div>
          {showToast && <div className="chat-toast">Copied to clipboard</div>}
        </div>
        <div className="chat-body" ref={chatBodyRef} role="log" aria-live="polite">
          {threadLoading && (
            <div className="thread-loading">
              <div className="loading">
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
              </div>
              <span className="thread-loading-text">Loading conversation...</span>
            </div>
          )}
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
            disabled={loading || pending}
            maxLength={5000}
            rows={1}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={pending ? "Waiting for response..." : viewingThread ? "Continue this conversation..." : "Ask anything"}
            autoFocus
            aria-label="Type your message"
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={loading || pending || !input.trim()}
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
