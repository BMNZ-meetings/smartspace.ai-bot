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

// PILOT PHASE: Thread storage limited to known testers.
// For production, replace with a HubSpot contact property flag or list membership check.
const THREAD_STORE_EMAILS = [
  "rbraamburg@bacpartners.com.au",
  "katrina@bmnz.org.nz",
  "colin@bmnz.org.nz",
  "june@bmnz.org.nz",
  "david.altena@smartspace.ai",
  "sarah@bmnz.org.nz",
  "duriemk@gmail.com",
  "justin@flitter.co.nz",
];

async function storeThreadId(email, threadId) {
  if (!THREAD_STORE_EMAILS.includes(email.toLowerCase())) {
    return;
  }
  try {
    const searchRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['smartspace_thread_ids']
      },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 5000 }
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
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 5000 }
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

      const smartspacePayload = {
        workSpaceId: SMARTSPACE_WORKSPACE_ID,
        inputs: [
          { name: "prompt", value: [{ text: chatMsg }] },
          { name: "email", value: userEmail },
        ],
      };

      // Only include messageThreadId if it exists (for follow-up messages)
      if (threadId) {
        smartspacePayload.messageThreadId = threadId;
      }

      console.log(`[CHAT] Sending (first=${isFirstMessage}, thread=${threadId || 'new'})`);

      try {
        const apiResponse = await axios.post(
          `${SMARTSPACE_API_URL}/messages`,
          smartspacePayload,
          {
            headers: authHeader,
            timeout: 7000, // Must be under HubSpot's 10s execution limit
          },
        );

        const responseThreadId = apiResponse.data.messageThreadId || threadId;
        console.log(`[CHAT] Response received (thread=${responseThreadId})`);

        // Store thread ID against HubSpot contact (fire-and-forget)
        if (isFirstMessage && responseThreadId) {
          storeThreadId(userEmail, responseThreadId);
        }

        return sendResponse({
          body: {
            success: true,
            messageThreadId: responseThreadId,
            messageId: apiResponse.data.id,
            status: "accepted",
            timestamp: new Date().toISOString(),
          },
          statusCode: 200,
        });
      } catch (chatError) {
        console.error("[CHAT] SmartSpace API Error:", {
          status: chatError.response?.status,
          statusText: chatError.response?.statusText,
          data: chatError.response?.data,
          message: chatError.message,
          isTimeout: chatError.code === "ECONNABORTED",
          isFirstMessage,
        });

        // SPECIAL HANDLING FOR FIRST MESSAGE TIMEOUT
        if (isFirstMessage && chatError.code === "ECONNABORTED") {
          console.log(
            "[CHAT] First message timed out - trying to find the created thread",
          );
          // The message was likely queued even though we timed out
          // Try to find the thread that was created
          try {
            const threadsResponse = await axios.get(
              `${SMARTSPACE_API_URL}/WorkSpaces/${SMARTSPACE_WORKSPACE_ID}/messageThreads?take=5`,
              {
                headers: authHeader,
                timeout: 2000,
              },
            );

            console.log(
              `[CHAT] Found ${threadsResponse.data.data?.length || 0} recent threads`,
            );

            // Look for a very recent thread (created in last 30 seconds)
            const now = new Date().getTime();
            const recentThreads = (threadsResponse.data.data || []).filter(
              (thread) => {
                const createdAt = new Date(thread.createdAt).getTime();
                const ageSeconds = (now - createdAt) / 1000;
                return ageSeconds < 30;
              },
            );

            // Verify ownership: check each candidate thread's first message
            // to ensure the email matches the requesting user
            let ownedThread = null;
            for (const candidate of recentThreads) {
              try {
                const threadMsgs = await axios.get(
                  `${SMARTSPACE_API_URL}/messagethreads/${candidate.id}/messages?take=1&skip=0`,
                  { headers: authHeader, timeout: 2000 },
                );
                const firstMsg = threadMsgs.data.data?.[0];
                const threadEmail = firstMsg?.values?.find(
                  (v) => v.name === "email" && v.type === "Input",
                )?.value;

                if (threadEmail === userEmail) {
                  ownedThread = candidate;
                  break;
                }
                console.warn(
                  `[CHAT] Thread ${candidate.id} belongs to a different user — skipping`,
                );
              } catch (verifyError) {
                console.warn(
                  `[CHAT] Could not verify thread ${candidate.id}:`,
                  verifyError.message,
                );
              }
            }

            if (ownedThread) {
              console.log(
                `[CHAT] Found verified thread: ${ownedThread.id}`,
              );
              // Store thread ID against HubSpot contact (fire-and-forget)
              storeThreadId(userEmail, ownedThread.id);
              return sendResponse({
                body: {
                  success: true,
                  messageThreadId: ownedThread.id,
                  status: "timeout_with_thread",
                  message: "Message was sent but response is pending",
                  timestamp: new Date().toISOString(),
                },
                statusCode: 200,
              });
            }

            console.warn(
              "[CHAT] No recent thread found, message may have failed",
            );
          } catch (findThreadError) {
            console.error(
              "[CHAT] Failed to find created thread:",
              findThreadError.message,
            );
          }

          // Couldn't find a thread, return error
          return sendResponse({
            body: {
              success: false,
              error: "First message timeout",
              message:
                "The chat service is taking longer than expected. Please try again.",
              canRetry: true,
              timestamp: new Date().toISOString(),
            },
            statusCode: 200, // Return 200 so frontend can handle gracefully
          });
        }

        // If we have a threadId (follow-up message), tell frontend to poll anyway
        if (threadId) {
          return sendResponse({
            body: {
              success: true,
              messageThreadId: threadId,
              status: "polling_required",
              error: "Message delivery uncertain",
            },
            statusCode: 200,
          });
        }

        // Other errors on first message
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
        // Fetch both thread status and latest messages in parallel
        const [threadRes, messagesRes] = await Promise.all([
          axios.get(`${SMARTSPACE_API_URL}/MessageThreads/${messageThreadId}`, {
            headers: authHeader,
            timeout: 8000,
          }),
          axios.get(
            `${SMARTSPACE_API_URL}/messagethreads/${messageThreadId}/messages?take=5&skip=0`,
            {
              headers: authHeader,
              timeout: 8000,
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
          console.log(`[STATUS] No output message found yet`);
          return sendResponse({
            body: {
              success: true,
              status: threadRes.data.isFlowRunning
                ? "processing"
                : "no_response",
              data: [],
              messageThreadId,
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

        // Also check if we've already seen this message ID
        const isNewMessage =
          !lastMessageId || latestOutputMessage.id !== lastMessageId;

        console.log(`[STATUS] Message analysis:`, {
          messageId: latestOutputMessage.id,
          messageTime: latestOutputMessage.createdAt,
          isFresh,
          isNewMessage,
          lastMessageId,
        });

        // Return the message only if it's both fresh AND new
        if (isFresh && isNewMessage) {
          return sendResponse({
            body: {
              success: true,
              status: "completed",
              data: latestOutputMessage.values,
              messageId: latestOutputMessage.id,
              messageThreadId,
            },
            statusCode: 200,
          });
        }

        // Message exists but it's stale or already shown
        return sendResponse({
          body: {
            success: true,
            status: threadRes.data.isFlowRunning ? "processing" : "stale",
            data: [],
            messageThreadId,
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
            if (Array.isArray(responseVal)) {
              const meaningful = responseVal.filter(
                (s) => typeof s === "string" && s.trim().length > 20
              );
              responseText = meaningful.length > 0
                ? meaningful[meaningful.length - 1]
                : responseVal[0] || "";
            } else {
              responseText = String(responseVal);
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
