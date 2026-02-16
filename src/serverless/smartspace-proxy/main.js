const axios = require("axios");

let cachedToken = null;
let tokenExpiry = 0;

const TENANT_ID = process.env.TENANT_ID;
const CLIENT_ID = process.env.YOUR_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUR_APP_CLIENT_SECRET;
const SMARTSPACE_APP_ID = process.env.SMARTSPACE_API_APP_ID;
const SMARTSPACE_WORKSPACE_ID = process.env.SMARTSPACE_WORKSPACE_ID;
const SMARTSPACE_API_URL = process.env.SMARTSPACE_CHAT_API_URL;

// Helper to get auth token
async function getAuthToken() {
  const now = Date.now();
  if (!cachedToken || now >= tokenExpiry - 120000) {
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
      tokenExpiry = now + tokenResponse.data.expires_in * 1000;
    } catch (error) {
      console.error(
        "Token acquisition failed:",
        error.response?.data || error.message,
      );
      throw new Error("Authentication failed");
    }
  }
  return cachedToken;
}

const VALID_ACTIONS = ["chat", "getStatus"];
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

      console.log(
        `[CHAT] Sending to SmartSpace (first=${isFirstMessage}):`,
        JSON.stringify(smartspacePayload, null, 2),
      );

      try {
        const apiResponse = await axios.post(
          `${SMARTSPACE_API_URL}/messages`,
          smartspacePayload,
          {
            headers: authHeader,
            timeout: isFirstMessage ? 15000 : 10000, // Longer timeout for first message
          },
        );

        console.log(
          `[CHAT] SmartSpace Response:`,
          JSON.stringify(apiResponse.data, null, 2),
        );

        // Extract the messageThreadId from response
        const responseThreadId = apiResponse.data.messageThreadId || threadId;

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
                timeout: 5000,
              },
            );

            console.log(
              `[CHAT] Found ${threadsResponse.data.data?.length || 0} recent threads`,
            );

            // Look for a very recent thread (created in last 30 seconds)
            const now = new Date().getTime();
            const recentThread = threadsResponse.data.data?.find((thread) => {
              const createdAt = new Date(thread.createdAt).getTime();
              const ageSeconds = (now - createdAt) / 1000;
              return ageSeconds < 30; // Thread created in last 30 seconds
            });

            if (recentThread) {
              console.log(
                `[CHAT] Found recent thread: ${recentThread.id}, polling will handle response`,
              );
              return sendResponse({
                body: {
                  success: true,
                  messageThreadId: recentThread.id,
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
              error: chatError.response?.data || chatError.message,
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
            success: true,
            status: "error_retry",
            data: [],
            messageThreadId,
            error: statusError.message,
          },
          statusCode: 200,
        });
      }
    }

  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error("[PROXY] Error:", JSON.stringify(errorData, null, 2));

    return sendResponse({
      body: {
        success: false,
        error: "Proxy Failure",
        details: errorData,
        timestamp: new Date().toISOString(),
      },
      statusCode: 500,
    });
  }
};
