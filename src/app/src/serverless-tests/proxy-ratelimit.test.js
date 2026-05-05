import { describe, it, expect, beforeEach } from "vitest";
import { makeContext, makeSendResponse } from "../../test/mocks/hubspotContext.js";
import { setupProxy } from "../../test/mocks/proxyTestHelper.js";

const VALID_THREAD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_EMAIL = "tester@example.com";
const OTHER_EMAIL = "other@example.com";

describe("rate limiting", () => {
  let proxyMain;
  let mockPost;
  let mockGet;

  beforeEach(async () => {
    const setup = await setupProxy();
    proxyMain = setup.proxyMain;
    mockPost = setup.mockPost;
    mockGet = setup.mockGet;
  });

  function mockAxiosForChat() {
    mockPost.mockImplementation((url) => {
      if (url.includes("oauth2")) {
        return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      }
      if (url.includes("/messagethreads")) {
        return Promise.resolve({ data: { id: VALID_THREAD_ID } });
      }
      if (url.includes("/messages")) {
        return Promise.resolve({
          data: { messageThreadId: VALID_THREAD_ID, id: "msg-1" },
        });
      }
      // HubSpot search (for storeThreadId fire-and-forget)
      if (url.includes("contacts/search")) {
        return Promise.resolve({ data: { results: [] } });
      }
      return Promise.reject(new Error(`Unmocked POST: ${url}`));
    });
  }

  async function sendChat(email = TEST_EMAIL) {
    const ctx = makeContext({
      email,
      body: { action: "chat", payload: { message: "hello" } },
    });
    const send = makeSendResponse();
    await proxyMain(ctx, send);
    return send.lastCall();
  }

  it("allows requests below rate limit threshold", async () => {
    mockAxiosForChat();

    for (let i = 0; i < 5; i++) {
      const res = await sendChat();
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });

  it("returns 429 after 20 chat requests in 60 seconds from same email", async () => {
    mockAxiosForChat();

    // Send 20 requests (the limit)
    for (let i = 0; i < 20; i++) {
      const res = await sendChat();
      expect(res.statusCode).toBe(200);
    }

    // 21st request should be rate limited
    const res = await sendChat();
    expect(res.statusCode).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Rate limit");
  });

  it("rate limit is per-user - different emails have independent limits", async () => {
    mockAxiosForChat();

    // Exhaust rate limit for TEST_EMAIL
    for (let i = 0; i < 20; i++) {
      await sendChat(TEST_EMAIL);
    }

    // TEST_EMAIL should be blocked
    const blockedRes = await sendChat(TEST_EMAIL);
    expect(blockedRes.statusCode).toBe(429);

    // OTHER_EMAIL should still work
    const okRes = await sendChat(OTHER_EMAIL);
    expect(okRes.statusCode).toBe(200);
    expect(okRes.body.success).toBe(true);
  });

  it("non-chat actions are not rate limited", async () => {
    mockAxiosForChat();

    // Exhaust rate limit for TEST_EMAIL on chat
    for (let i = 0; i < 20; i++) {
      await sendChat(TEST_EMAIL);
    }

    // Chat should be blocked
    const chatRes = await sendChat(TEST_EMAIL);
    expect(chatRes.statusCode).toBe(429);

    // But getHistory should still work (no rate limit on non-chat actions)
    mockPost.mockImplementation((url) => {
      if (url.includes("oauth2")) {
        return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      }
      if (url.includes("contacts/search")) {
        return Promise.resolve({ data: { results: [] } });
      }
      return Promise.reject(new Error(`Unmocked POST: ${url}`));
    });

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "getHistory" },
    });
    const send = makeSendResponse();
    await proxyMain(ctx, send);

    const res = send.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
