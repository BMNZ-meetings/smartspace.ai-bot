import { describe, it, expect, beforeEach } from "vitest";
import { makeContext, makeSendResponse } from "../../test/mocks/hubspotContext.js";
import { setupProxy } from "../../test/mocks/proxyTestHelper.js";

const VALID_THREAD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_EMAIL = "tester@example.com";

function makeMessage({ id, email, prompt, response, createdAt }) {
  const values = [];
  if (email) values.push({ name: "email", type: "Input", value: email });
  if (prompt) values.push({ name: "prompt", type: "Input", value: [{ text: prompt }] });
  if (response !== undefined) {
    values.push({ name: "Response", type: "Output", value: response });
  }
  return { id, createdAt: createdAt || "2026-04-01T10:00:00Z", values };
}

describe("getThread action", () => {
  let proxyMain;
  let mockPost;
  let mockGet;
  let sendResponse;

  beforeEach(async () => {
    const setup = await setupProxy();
    proxyMain = setup.proxyMain;
    mockPost = setup.mockPost;
    mockGet = setup.mockGet;
    sendResponse = makeSendResponse();
  });

  function mockTokenCall() {
    mockPost.mockImplementation((url) => {
      if (url.includes("oauth2")) {
        return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      }
      return Promise.reject(new Error(`Unmocked POST: ${url}`));
    });
  }

  function mockThreadMessages(messages) {
    mockGet.mockImplementation((url) => {
      if (url.includes("/messages")) {
        return Promise.resolve({ data: { data: messages } });
      }
      return Promise.reject(new Error(`Unmocked GET: ${url}`));
    });
  }

  it("returns messages in chronological order (oldest first)", async () => {
    mockTokenCall();

    // API returns newest first: msg-2 (newer), msg-1 (older)
    const messages = [
      makeMessage({ id: "msg-2", email: TEST_EMAIL, prompt: "Follow-up", response: "Follow-up answer", createdAt: "2026-04-01T11:00:00Z" }),
      makeMessage({ id: "msg-1", email: TEST_EMAIL, prompt: "First question", response: "First answer", createdAt: "2026-04-01T10:00:00Z" }),
    ];
    mockThreadMessages(messages);

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "getThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // First parsed message should be from the older message (msg-1)
    expect(res.body.messages[0]).toMatchObject({ sender: "user", text: "First question" });
    expect(res.body.messages[1]).toMatchObject({ sender: "bot", text: "First answer" });
    expect(res.body.messages[2]).toMatchObject({ sender: "user", text: "Follow-up" });
    expect(res.body.messages[3]).toMatchObject({ sender: "bot", text: "Follow-up answer" });
  });

  it("verifies email ownership on oldest message and returns 403 on mismatch", async () => {
    mockTokenCall();

    // Oldest message (last in array) has a different email
    const messages = [
      makeMessage({ id: "msg-2", email: TEST_EMAIL, prompt: "Follow-up", createdAt: "2026-04-01T11:00:00Z" }),
      makeMessage({ id: "msg-1", email: "other@example.com", prompt: "First", createdAt: "2026-04-01T10:00:00Z" }),
    ];
    mockThreadMessages(messages);

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "getThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Access denied");
  });

  it("returns empty messages for empty thread", async () => {
    mockTokenCall();
    mockThreadMessages([]);

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "getThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messages).toEqual([]);
  });

  it("returns 400 for invalid threadId format", async () => {
    mockTokenCall();

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "getThread", payload: { threadId: "not-a-uuid" } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("Invalid threadId");
  });

  it("does NOT mutate original allMessages array", async () => {
    mockTokenCall();

    const messages = [
      makeMessage({ id: "msg-2", email: TEST_EMAIL, prompt: "Second", createdAt: "2026-04-01T11:00:00Z" }),
      makeMessage({ id: "msg-1", email: TEST_EMAIL, prompt: "First", createdAt: "2026-04-01T10:00:00Z" }),
    ];

    const originalFirstId = messages[0].id;
    mockThreadMessages(messages);

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "getThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    // The source array should still have msg-2 first (newest-first order preserved)
    expect(messages[0].id).toBe(originalFirstId);
  });

  it("parses array-type response values and filters for meaningful strings", async () => {
    mockTokenCall();

    const messages = [
      makeMessage({
        id: "msg-1",
        email: TEST_EMAIL,
        prompt: "Tell me about LIFT",
        response: [
          "short",
          "This is a meaningful response that is definitely longer than twenty characters.",
          "Also meaningful and long enough to pass the filter easily here.",
        ],
        createdAt: "2026-04-01T10:00:00Z",
      }),
    ];
    mockThreadMessages(messages);

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "getThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    const botMsg = res.body.messages.find((m) => m.sender === "bot");
    // The proxy picks the LAST meaningful string (>20 chars)
    expect(botMsg.text).toBe("Also meaningful and long enough to pass the filter easily here.");
  });
});
