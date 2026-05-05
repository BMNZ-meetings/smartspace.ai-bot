const axios = require("axios");

let cachedToken = null;
let tokenExpiry = 0;
let tokenPromise = null;

const TENANT_ID = process.env.TENANT_ID;
const CLIENT_ID = process.env.YOUR_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUR_APP_CLIENT_SECRET;
const SMARTSPACE_APP_ID = process.env.SMARTSPACE_API_APP_ID;
const SMARTSPACE_WORKSPACE_ID = process.env.SMARTSPACE_WORKSPACE_ID;
const SMARTSPACE_API_URL = process.env.SMARTSPACE_CHAT_API_URL;

// Helper to get auth token (promise singleton prevents thundering herd on expiry)
async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 120000) {
    return cachedToken;
  }
  // If a fetch is already in flight, reuse its promise
  if (tokenPromise) {
    return tokenPromise;
  }
  tokenPromise = (async () => {
    try {
      const tokenResponse = await axios.post(
        `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "client_credentials",
          scope: `api://${SMARTSPACE_APP_ID}/.default`,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      cachedToken = tokenResponse.data.access_token;
      tokenExpiry = Date.now() + tokenResponse.data.expires_in * 1000;
      return cachedToken;
    } catch (error) {
      console.error(
        "Token acquisition failed:",
        error.response?.data || error.message,
      );
      throw new Error("Authentication failed");
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

const HUBSPOT_TOKEN = process.env.bac_private_token;

// Thread storage is available to all authenticated contacts on the Digital Mentor pilot.
async function storeThreadId(email, threadId) {
  try {
    const searchRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['smartspace_thread_ids']
      },
      // Tight timeout — storeThreadId is fire-and-forget; its tail must drain quickly
      // so it doesn't extend the Lambda event loop past HubSpot's 10s kill.
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 2000 }
    );

    const contact = searchRes.data.results?.[0];
    if (!contact) {
      console.warn(`[THREAD-STORE] No contact found for ${email}`);
      return;
    }

    let threadIds = [];
    try {
      threadIds = JSON.parse(contact.properties.smartspace_thread_ids || '[]');
    } catch (e) {
      threadIds = [];
    }

    if (!threadIds.includes(threadId)) {
      threadIds.push(threadId);
    }

    // Cap at 500 most recent to stay within HubSpot property limits (~19,500 chars vs 65,536 limit)
    if (threadIds.length > 500) {
      threadIds = threadIds.slice(-500);
    }

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      { properties: { smartspace_thread_ids: JSON.stringify(threadIds) } },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 2000 }
    );

    console.log(`[THREAD-STORE] Stored thread ${threadId} for ${email} (total: ${threadIds.length})`);
  } catch (err) {
    console.error(`[THREAD-STORE] Failed to store thread for ${email}:`, err.message);
  }
}

const VALID_ACTIONS = ["chat", "getStatus", "getHistory", "getThread", "deleteThread"];
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 5000;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60000;
const rateLimitMap = new Map();

function isRateLimited(key) {
  const now = Date.now();
  const timestamps = rateLimitMap.get(key) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(key, recent);
    return true;
  }

  recent.push(now);
  rateLimitMap.set(key, recent);

  // Prune stale keys every 100 checks to prevent unbounded growth
  if (rateLimitMap.size > 50) {
    for (const [k, v] of rateLimitMap) {
      const active = v.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (active.length === 0) rateLimitMap.delete(k);
    }
  }

  return false;
}

exports.main = async (context, sendResponse) => {
  const { body } = context;
  const { action, payload } = body;

  // Validate action
  if (!action || !VALID_ACTIONS.includes(action)) {
    return sendResponse({
      body: { success: false, error: "Invalid action" },
      statusCode: 400,
    });
  }

  if (!payload && action !== "getHistory") {
    return sendResponse({
      body: { success: false, error: "Missing payload" },
      statusCode: 400,
    });
  }

  // Authenticate the calling user via HubSpot contact context
  const contact = context.contact;
  if (!contact) {
    return sendResponse({
      body: {
        success: false,
        error: "Unauthorized",
        message: "You must be logged in to use this service.",
      },
      statusCode: 401,
    });
  }

  const userEmail = contact.email;
  if (!userEmail) {
    return sendResponse({
      body: {
        success: false,
        error: "Unauthorized",
        message: "No email associated with your account.",
      },
      statusCode: 401,
    });
  }

  try {
    const token = await getAuthToken();
    const authHeader = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // NOTE: Action dispatch via if-chain. Consider refactoring to a handler map if more actions are added.
    // ============================================
    // ACTION: CHAT
    // ============================================
    if (action === "chat") {
      // Rate limit chat messages per user
      if (isRateLimited(userEmail)) {
        return sendResponse({
          body: {
            success: false,
            error: "Rate limit exceeded",
            message: "Too many messages. Please wait a moment before trying again.",
          },
          statusCode: 429,
        });
      }

      const chatMsg = payload.message || "Hello";
      const threadId = payload.messageThreadId || null;

      // Validate message length
      if (chatMsg.length > MAX_MESSAGE_LENGTH) {
        return sendResponse({
          body: {
            success: false,
            error: "Message too long",
            message: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
          },
          statusCode: 400,
        });
      }

      // Validate messageThreadId format if provided
      if (threadId && !UUID_REGEX.test(threadId)) {
        return sendResponse({
          body: { success: false, error: "Invalid messageThreadId format" },
          statusCode: 400,
        });
      }
      const isFirstMessage = !threadId;

      // Two-step pattern (agreed with SmartSpace/Stefan): create thread first, then send
      // the message. SmartSpace's /messages endpoint can hold the connection open beyond
      // HubSpot's 10s execution limit, so we use a tight axios timeout on the message send
      // and let the catch block convert a timeout into `polling_required` for the widget.
      //
      // Timeout budget (HubSpot hard-kills at 10s):
      //   thread create (5s) + message send (4s) = 9s worst case in this handler.
      //   Thread create gets the larger share because it's the critical path — a failed
      //   thread create is unrecoverable, whereas a message-send timeout falls through to
      //   polling where the widget can still pick up the response.
      //   storeThreadId runs fire-and-forget with its own tight internal timeouts (see top of file).
      let activeThreadId = threadId;

      if (isFirstMessage) {
        try {
          console.log("[CHAT] Creating thread first (two-step pattern)");
          const threadResponse = await axios.post(
            `${SMARTSPACE_API_URL}/workspaces/${SMARTSPACE_WORKSPACE_ID}/messagethreads`,
            { name: chatMsg.substring(0, 120) },
            { headers: authHeader, timeout: 5000 },
          );
          activeThreadId = threadResponse.data.id;
          console.log(`[CHAT] Thread created: ${activeThreadId}`);

          // Store thread ID against HubSpot contact (fire-and-forget)
          storeThreadId(userEmail, activeThreadId);
        } catch (createError) {
          console.error("[CHAT] Failed to create thread:", createError.message);
          return sendResponse({
            body: {
              success: false,
              error: "Failed to start conversation",
              message: "The chat service is temporarily unavailable. Please try again.",
              canRetry: true,
              timestamp: new Date().toISOString(),
            },
            statusCode: 200,
          });
        }
      }

      const smartspacePayload = {
        workSpaceId: SMARTSPACE_WORKSPACE_ID,
        messageThreadId: activeThreadId,
        inputs: [
          { name: "prompt", value: [{ text: chatMsg }] },
          { name: "email", value: userEmail },
        ],
      };

      console.log(`[CHAT] Sending message (first=${isFirstMessage}, thread=${activeThreadId})`);

      try {
        const apiResponse = await axios.post(
          `${SMARTSPACE_API_URL}/messages`,
          smartspacePayload,
          {
            headers: authHeader,
            timeout: 4000, // Kept tight so thread_create + message_send stays under HubSpot's 10s kill.
          },
        );

        console.log(`[CHAT] Response received (thread=${activeThreadId})`);

        return sendResponse({
          body: {
            success: true,
            messageThreadId: activeThreadId,
            messageId: apiResponse.data.id,
            status: "accepted",
            timestamp: new Date().toISOString(),
          },
          statusCode: 200,
        });
      } catch (chatError) {
        const isTimeout = chatError.code === "ECONNABORTED";
        if (isTimeout) {
          console.warn(`[CHAT] Message send timed out (${isFirstMessage ? "first" : "follow-up"}) - returning polling_required`);
        } else {
          console.error("[CHAT] SmartSpace API Error:", {
            status: chatError.response?.status,
            statusText: chatError.response?.statusText,
            data: chatError.response?.data,
            message: chatError.message,
          });
        }

        // For any timeout or error, return polling_required with the thread ID.
        // SmartSpace continues processing even if we abort the connection.
        if (activeThreadId) {
          return sendResponse({
            body: {
              success: true,
              messageThreadId: activeThreadId,
              status: "polling_required",
              error: "Message delivery uncertain",
            },
            statusCode: 200,
          });
        }

        // No thread ID available at all - unrecoverable
        throw chatError;
      }
    }

    // ============================================
    // ACTION: GET STATUS
    // ============================================
    if (action === "getStatus") {
      const { messageThreadId, lastUserMessageTime, lastMessageId } = payload;

      // Validate messageThreadId format
      if (!messageThreadId || !UUID_REGEX.test(messageThreadId)) {
        return sendResponse({
          body: { success: false, error: "Invalid messageThreadId format" },
          statusCode: 400,
        });
      }

      console.log(
        `[STATUS] Checking thread ${messageThreadId}, last message time: ${lastUserMessageTime}`,
      );

      try {
        // Fetch both thread status and latest messages in parallel.
        // Tightened from 8000ms each to 5000ms each: both run in parallel but each is
        // still bounded by HubSpot's 10s kill if one hangs.
        const [threadRes, messagesRes] = await Promise.all([
          axios.get(`${SMARTSPACE_API_URL}/MessageThreads/${messageThreadId}`, {
            headers: authHeader,
            timeout: 5000,
          }),
          axios.get(
            `${SMARTSPACE_API_URL}/messagethreads/${messageThreadId}/messages?take=5&skip=0`,
            {
              headers: authHeader,
              timeout: 5000,
            },
          ),
        ]);

        console.log(
          `[STATUS] Thread isFlowRunning: ${threadRes.data.isFlowRunning}`,
        );
        console.log(
          `[STATUS] Messages count: ${messagesRes.data.data?.length || 0}`,
        );

        const messages = messagesRes.data.data || [];

        // Extract the latest SmartSpace "Status" value across all messages for this thread.
        // SmartSpace appends Status values (type=Output, name=Status) to the active message
        // as work progresses (e.g. "Searching meeting minutes...", "Generating response...").
        // We surface the most recent one to the widget so the user gets progressive feedback.
        // Values are defensively extracted - SmartSpace may emit a plain string, an array of
        // strings, or an array of { text: "..." } objects depending on the tool.
        const extractText = (raw) => {
          if (!raw) return null;
          if (typeof raw === "string") return raw;
          if (Array.isArray(raw) && raw.length > 0) {
            const last = raw[raw.length - 1]; // Use the most recent entry
            if (typeof last === "string") return last;
            if (last && typeof last.text === "string") return last.text;
          }
          if (typeof raw === "object" && typeof raw.text === "string") return raw.text;
          return null;
        };
        let latestStatusText = null;
        for (const msg of messages) {
          const statusValues = (msg.values || []).filter(
            (v) =>
              (v.type === "Output" || String(v.type) === "2") &&
              v.name === "Status",
          );
          if (statusValues.length > 0) {
            latestStatusText = extractText(statusValues[statusValues.length - 1].value);
            if (latestStatusText) break;
          }
        }

        // Find the most recent Output message
        let latestOutputMessage = null;
        for (const msg of messages) {
          const hasOutput = msg.values?.some(
            (v) =>
              (v.type === "Output" || String(v.type) === "2") &&
              v.name === "Response",
          );

          if (hasOutput) {
            latestOutputMessage = msg;
            break; // Messages are already sorted newest first
          }
        }

        // If no output message found, check if flow is still running
        if (!latestOutputMessage) {
          console.log(`[STATUS] No output message found yet (currentStatus=${latestStatusText || "null"})`);
          return sendResponse({
            body: {
              success: true,
              status: threadRes.data.isFlowRunning
                ? "processing"
                : "no_response",
              data: [],
              messageThreadId,
              currentStatus: latestStatusText,
            },
            statusCode: 200,
          });
        }

        // Check if this message is newer than the user's last message
        const msgTimestamp = new Date(latestOutputMessage.createdAt).getTime();
        const userMsgTimestamp = lastUserMessageTime
          ? new Date(lastUserMessageTime).getTime()
          : 0;

        // 15-second buffer to account for clock drift and processing time
        const isFresh = msgTimestamp > userMsgTimestamp - 15000;

        const isNewMessage =
          !lastMessageId || latestOutputMessage.id !== lastMessageId;

        console.log(`[STATUS] Message analysis:`, {
          messageId: latestOutputMessage.id,
          isFresh,
          isNewMessage,
          isFlowRunning: threadRes.data.isFlowRunning,
          lastMessageId,
        });

        // Streaming-aware return path: always emit the latest values for a fresh
        // message, regardless of whether we've seen its id before. The widget uses
        // status to decide whether to keep polling ("streaming") or stop ("completed"),
        // and uses the value lengths to detect growth between polls. This is what
        // lets the widget render Response text progressively as SmartSpace streams it.
        if (isFresh) {
          return sendResponse({
            body: {
              success: true,
              status: threadRes.data.isFlowRunning ? "streaming" : "completed",
              data: latestOutputMessage.values,
              messageId: latestOutputMessage.id,
              messageThreadId,
              currentStatus: latestStatusText,
            },
            statusCode: 200,
          });
        }

        // Stale: the message we found is older than the user's last send. Tell the
        // widget to stop polling.
        return sendResponse({
          body: {
            success: true,
            status: threadRes.data.isFlowRunning ? "processing" : "stale",
            data: [],
            messageThreadId,
            currentStatus: latestStatusText,
          },
          statusCode: 200,
        });
      } catch (statusError) {
        console.error("[STATUS] Error:", {
          status: statusError.response?.status,
          data: statusError.response?.data,
          message: statusError.message,
        });

        // Return processing status on error to allow retry
        return sendResponse({
          body: {
            success: false,
            status: "error_retry",
            data: [],
            messageThreadId,
            error: statusError.message,
          },
          statusCode: 200,
        });
      }
    }

    // ============================================
    // ACTION: GET HISTORY
    // ============================================
    if (action === "getHistory") {
      console.log(`[HISTORY] Fetching thread history for ${userEmail}`);

      try {
        // Fetch thread IDs from HubSpot contact
        const searchRes = await axios.post(
          'https://api.hubapi.com/crm/v3/objects/contacts/search',
          {
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: userEmail }] }],
            properties: ['smartspace_thread_ids']
          },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 5000 }
        );

        const hsContact = searchRes.data.results?.[0];
        if (!hsContact) {
          return sendResponse({
            body: { success: true, threads: [] },
            statusCode: 200,
          });
        }

        let threadIds = [];
        try {
          threadIds = JSON.parse(hsContact.properties.smartspace_thread_ids || '[]');
        } catch (e) {
          threadIds = [];
        }

        if (threadIds.length === 0) {
          return sendResponse({
            body: { success: true, threads: [] },
            statusCode: 200,
          });
        }

        // Fetch first message from each thread (in parallel, max 20)
        const threadSummaries = [];
        // Thread list capped at 20. Implement pagination or cache summaries in
        // HubSpot contact property to reduce per-load SmartSpace API calls.
        const batch = threadIds.slice(-20).reverse(); // Most recent first

        const results = await Promise.allSettled(
          batch.map(async (tid) => {
            // Validate UUID format before calling SmartSpace
            if (!UUID_REGEX.test(tid)) {
              console.warn(`[HISTORY] Skipping invalid thread ID: ${tid}`);
              return null;
            }

            // Fetch the most recent message (API returns newest first)
            // Email input is on every message, so newest is valid for ownership check
            // We also need the oldest for the first prompt, so fetch both ends
            const msgRes = await axios.get(
              `${SMARTSPACE_API_URL}/messagethreads/${tid}/messages?take=1&skip=0`,
              { headers: authHeader, timeout: 5000 }
            );

            const newestMsg = msgRes.data.data?.[0];
            if (!newestMsg) return null;

            // Verify email ownership on the newest message
            const threadEmail = newestMsg.values?.find(
              (v) => v.name === "email" && v.type === "Input"
            )?.value;

            if (threadEmail?.toLowerCase() !== userEmail.toLowerCase()) {
              console.warn(`[HISTORY] Thread ${tid} email mismatch: ${threadEmail} !== ${userEmail}`);
              return null;
            }

            // For the first prompt: if this is the only message, use it; otherwise fetch the oldest
            const total = msgRes.data.total || 1;
            let promptMsg = newestMsg;
            if (total > 1) {
              try {
                const oldestRes = await axios.get(
                  `${SMARTSPACE_API_URL}/messagethreads/${tid}/messages?take=1&skip=${total - 1}`,
                  { headers: authHeader, timeout: 3000 }
                );
                promptMsg = oldestRes.data.data?.[0] || newestMsg;
              } catch {
                // Fall back to newest message prompt if oldest fetch fails
              }
            }

            // Extract first prompt
            const promptVal = promptMsg.values?.find(
              (v) => v.name === "prompt" && v.type === "Input"
            )?.value;

            let promptText = "";
            if (Array.isArray(promptVal)) {
              promptText = promptVal[0]?.text || JSON.stringify(promptVal);
            } else {
              promptText = String(promptVal || "");
            }

            return {
              threadId: tid,
              firstPrompt: promptText.substring(0, 120),
              date: promptMsg.createdAt,
            };
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled" && result.value) {
            threadSummaries.push(result.value);
          }
        }

        console.log(`[HISTORY] Returning ${threadSummaries.length} threads for ${userEmail}`);

        return sendResponse({
          body: { success: true, threads: threadSummaries },
          statusCode: 200,
        });
      } catch (historyError) {
        console.error("[HISTORY] Error:", historyError.message);
        return sendResponse({
          body: { success: false, threads: [], error: historyError.message },
          statusCode: 200,
        });
      }
    }

    // ============================================
    // ACTION: GET THREAD
    // ============================================
    if (action === "getThread") {
      const { threadId } = payload;

      if (!threadId || !UUID_REGEX.test(threadId)) {
        return sendResponse({
          body: { success: false, error: "Invalid threadId format" },
          statusCode: 400,
        });
      }

      console.log(`[THREAD] Fetching full thread ${threadId} for ${userEmail}`);

      try {
        // Thread messages capped at 100. Pagination not yet implemented.
        const messagesRes = await axios.get(
          `${SMARTSPACE_API_URL}/messagethreads/${threadId}/messages?take=100&skip=0`,
          { headers: authHeader, timeout: 8000 }
        );

        const allMessages = messagesRes.data.data || [];

        // Reject empty threads - no messages means no ownership to verify
        if (allMessages.length === 0) {
          return sendResponse({
            body: { success: true, threadId, messages: [] },
            statusCode: 200,
          });
        }

        // Verify email ownership on the oldest message
        {
          const firstMsg = allMessages[allMessages.length - 1]; // Oldest message (API returns newest first)
          const threadEmail = firstMsg.values?.find(
            (v) => v.name === "email" && v.type === "Input"
          )?.value;

          if (threadEmail?.toLowerCase() !== userEmail.toLowerCase()) {
            console.warn(`[THREAD] Access denied: thread ${threadId} belongs to ${threadEmail}, not ${userEmail}`);
            return sendResponse({
              body: { success: false, error: "Access denied" },
              statusCode: 403,
            });
          }
        }

        // Parse messages into a clean format
        const parsed = [];
        for (const msg of [...allMessages].reverse()) { // Chronological order
          const promptVal = msg.values?.find(
            (v) => v.name === "prompt" && v.type === "Input"
          )?.value;
          const responseVal = msg.values?.find(
            (v) => v.name === "Response" && (v.type === "Output" || String(v.type) === "2")
          )?.value;

          let promptText = "";
          if (promptVal) {
            if (Array.isArray(promptVal)) {
              promptText = promptVal[0]?.text || JSON.stringify(promptVal);
            } else {
              promptText = String(promptVal);
            }
          }

          let responseText = "";
          if (responseVal) {
            // Response.value shape varies: plain string (non-streaming workspaces),
            // object with `response` field (streaming workspaces), or array
            // (legacy multi-output). Handle all three.
            if (typeof responseVal === "string") {
              responseText = responseVal;
            } else if (responseVal && typeof responseVal === "object" && !Array.isArray(responseVal)) {
              if (typeof responseVal.response === "string") responseText = responseVal.response;
              else if (typeof responseVal.text === "string") responseText = responseVal.text;
              else if (typeof responseVal.value === "string") responseText = responseVal.value;
            } else if (Array.isArray(responseVal)) {
              const meaningful = responseVal.filter(
                (s) => typeof s === "string" && s.trim().length > 20
              );
              responseText = meaningful.length > 0
                ? meaningful[meaningful.length - 1]
                : (typeof responseVal[0] === "string" ? responseVal[0] : "");
            }
          }

          if (promptText) {
            parsed.push({ sender: "user", text: promptText.trim(), date: msg.createdAt });
          }
          if (responseText) {
            parsed.push({ sender: "bot", text: responseText.trim(), date: msg.createdAt });
          }
        }

        console.log(`[THREAD] Returning ${parsed.length} messages for thread ${threadId}`);

        return sendResponse({
          body: { success: true, threadId, messages: parsed },
          statusCode: 200,
        });
      } catch (threadError) {
        console.error("[THREAD] Error:", threadError.message);
        return sendResponse({
          body: { success: false, error: threadError.message },
          statusCode: 500,
        });
      }
    }

    // ============================================
    // ACTION: DELETE THREAD
    // ============================================
    if (action === "deleteThread") {
      const { threadId } = payload;

      if (!threadId || !UUID_REGEX.test(threadId)) {
        return sendResponse({
          body: { success: false, error: "Invalid threadId format" },
          statusCode: 400,
        });
      }

      console.log(`[DELETE] Removing thread ${threadId} for ${userEmail}`);

      try {
        // Fetch current thread IDs from HubSpot
        const searchRes = await axios.post(
          'https://api.hubapi.com/crm/v3/objects/contacts/search',
          {
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: userEmail }] }],
            properties: ['smartspace_thread_ids']
          },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 5000 }
        );

        const hsContact = searchRes.data.results?.[0];
        if (!hsContact) {
          return sendResponse({
            body: { success: false, error: "Contact not found" },
            statusCode: 404,
          });
        }

        let threadIds = [];
        try {
          threadIds = JSON.parse(hsContact.properties.smartspace_thread_ids || '[]');
        } catch (e) {
          threadIds = [];
        }

        // Remove the thread ID
        const updated = threadIds.filter(id => id !== threadId);

        if (updated.length === threadIds.length) {
          // Thread ID wasn't in the list - still return success
          return sendResponse({
            body: { success: true, threadId },
            statusCode: 200,
          });
        }

        // Patch back to HubSpot
        await axios.patch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${hsContact.id}`,
          { properties: { smartspace_thread_ids: JSON.stringify(updated) } },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 5000 }
        );

        console.log(`[DELETE] Removed thread ${threadId} for ${userEmail} (remaining: ${updated.length})`);

        return sendResponse({
          body: { success: true, threadId },
          statusCode: 200,
        });
      } catch (deleteError) {
        console.error("[DELETE] Error:", deleteError.message);
        return sendResponse({
          body: { success: false, error: deleteError.message },
          statusCode: 500,
        });
      }
    }

  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error("[PROXY] Error:", JSON.stringify(errorData, null, 2));

    return sendResponse({
      body: {
        success: false,
        error: "An internal error occurred",
        timestamp: new Date().toISOString(),
      },
      statusCode: 500,
    });
  }
};
