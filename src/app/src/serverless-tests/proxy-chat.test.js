import { describe, it, expect, beforeEach } from "vitest";
import { makeContext, makeSendResponse } from "../../test/mocks/hubspotContext.js";
import { setupProxy } from "../../test/mocks/proxyTestHelper.js";

const VALID_THREAD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function mockAxiosForChat(mockPost, mockPatch, overrides = {}) {
  mockPost.mockImplementation((url) => {
    if (url.includes("oauth2")) {
      return Promise.resolve({
        data: { access_token: "test-token", expires_in: 3600 },
      });
    }
    if (url.includes("/messagethreads")) {
      return Promise.resolve(
        overrides.threadCreateResponse || {
          data: { id: VALID_THREAD_ID },
        },
      );
    }
    if (url.includes("/messages")) {
      return Promise.resolve(
        overrides.messagesResponse || {
          data: { id: "msg-001", messageThreadId: VALID_THREAD_ID },
        },
      );
    }
    if (url.includes("contacts/search")) {
      return Promise.resolve(
        overrides.contactSearchResponse || {
          data: {
            results: [{
              id: "101",
              properties: { smartspace_thread_ids: "[]" },
            }],
          },
        },
      );
    }
    return Promise.reject(new Error(`Unexpected POST to ${url}`));
  });

  mockPatch.mockResolvedValue({ data: {} });
}

describe("proxy chat action", () => {
  let proxyMain;
  let mockPost;
  let mockPatch;
  let sendResponse;

  beforeEach(async () => {
    const setup = await setupProxy();
    proxyMain = setup.proxyMain;
    mockPost = setup.mockPost;
    mockPatch = setup.mockPatch;
    sendResponse = makeSendResponse();
  });

  it("sends correct SmartSpace payload with workSpaceId, prompt, and email", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx = makeContext({
      email: "user@test.com",
      body: { action: "chat", payload: { message: "What is BMNZ?" } },
    });

    await proxyMain(ctx, sendResponse);

    const smartspaceCall = mockPost.mock.calls.find(
      ([url]) => url.includes("/messages"),
    );
    expect(smartspaceCall).toBeDefined();

    const [, sentPayload] = smartspaceCall;
    expect(sentPayload.workSpaceId).toBe("ws-123");
    expect(sentPayload.inputs).toEqual(
      expect.arrayContaining([
        { name: "prompt", value: [{ text: "What is BMNZ?" }] },
        { name: "email", value: "user@test.com" },
      ]),
    );
  });

  it("includes messageThreadId for follow-up messages", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx = makeContext({
      email: "user@test.com",
      body: {
        action: "chat",
        payload: { message: "Tell me more", messageThreadId: VALID_THREAD_ID },
      },
    });

    await proxyMain(ctx, sendResponse);

    const smartspaceCall = mockPost.mock.calls.find(
      ([url]) => url.includes("/messages"),
    );
    const [, sentPayload] = smartspaceCall;
    expect(sentPayload.messageThreadId).toBe(VALID_THREAD_ID);
  });

  it("creates thread first for first messages, then sends message with that threadId", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx = makeContext({
      email: "user@test.com",
      body: { action: "chat", payload: { message: "Hello" } },
    });

    await proxyMain(ctx, sendResponse);

    // Should have called /messagethreads first
    const threadCreateCall = mockPost.mock.calls.find(
      ([url]) => url.includes("/messagethreads"),
    );
    expect(threadCreateCall).toBeDefined();

    // Then /messages with the pre-created threadId
    const smartspaceCall = mockPost.mock.calls.find(
      ([url]) => url.includes("/messages") && !url.includes("/messagethreads"),
    );
    const [, sentPayload] = smartspaceCall;
    expect(sentPayload.messageThreadId).toBe(VALID_THREAD_ID);
  });

  it("returns messageThreadId on success", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx = makeContext({
      email: "user@test.com",
      body: { action: "chat", payload: { message: "Hello" } },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messageThreadId).toBe(VALID_THREAD_ID);
  });

  it("returns 400 for message exceeding 5000 chars", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx = makeContext({
      email: "user@test.com",
      body: {
        action: "chat",
        payload: { message: "x".repeat(5001) },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Message too long");
  });

  it("returns 400 for invalid UUID in messageThreadId", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx = makeContext({
      email: "user@test.com",
      body: {
        action: "chat",
        payload: { message: "Hello", messageThreadId: "not-a-uuid" },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid messageThreadId format");
  });

  it("caches token: second call reuses cached token (Azure AD called once)", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx1 = makeContext({
      email: "user@test.com",
      body: { action: "chat", payload: { message: "First" } },
    });
    const ctx2 = makeContext({
      email: "user@test.com",
      body: { action: "chat", payload: { message: "Second" } },
    });

    await proxyMain(ctx1, makeSendResponse());
    await proxyMain(ctx2, makeSendResponse());

    const tokenCalls = mockPost.mock.calls.filter(
      ([url]) => url.includes("oauth2"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("concurrent calls share one token promise (singleton)", async () => {
    mockAxiosForChat(mockPost, mockPatch);

    const ctx1 = makeContext({
      email: "user1@test.com",
      body: { action: "chat", payload: { message: "A" } },
    });
    const ctx2 = makeContext({
      email: "user2@test.com",
      body: { action: "chat", payload: { message: "B" } },
    });

    await Promise.all([
      proxyMain(ctx1, makeSendResponse()),
      proxyMain(ctx2, makeSendResponse()),
    ]);

    const tokenCalls = mockPost.mock.calls.filter(
      ([url]) => url.includes("oauth2"),
    );
    expect(tokenCalls).toHaveLength(1);
  });
});
