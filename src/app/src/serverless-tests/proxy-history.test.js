import { describe, it, expect, beforeEach } from "vitest";
import { makeContext, makeSendResponse } from "../../test/mocks/hubspotContext.js";
import { setupProxy } from "../../test/mocks/proxyTestHelper.js";

const VALID_THREAD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const VALID_THREAD_ID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const TEST_EMAIL = "tester@example.com";

describe("getHistory action", () => {
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

  function mockTokenAndSearch(contactSearchResponse) {
    mockPost.mockImplementation((url) => {
      if (url.includes("oauth2")) {
        return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      }
      if (url.includes("contacts/search")) {
        return Promise.resolve(contactSearchResponse);
      }
      return Promise.reject(new Error(`Unmocked POST: ${url}`));
    });
  }

  function mockSmartSpaceMessages(msgFactory) {
    mockGet.mockImplementation((url) => {
      if (url.includes("/messages")) {
        return Promise.resolve(msgFactory(url));
      }
      return Promise.reject(new Error(`Unmocked GET: ${url}`));
    });
  }

  it("returns empty threads when HubSpot contact search returns no results", async () => {
    mockTokenAndSearch({ data: { results: [] } });

    const ctx = makeContext({ email: TEST_EMAIL, body: { action: "getHistory" } });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.threads).toEqual([]);
  });

  it("returns empty threads when contact has no smartspace_thread_ids property", async () => {
    mockTokenAndSearch({
      data: {
        results: [{ id: "101", properties: { smartspace_thread_ids: "" } }],
      },
    });

    const ctx = makeContext({ email: TEST_EMAIL, body: { action: "getHistory" } });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.threads).toEqual([]);
  });

  it("parses thread IDs and fetches first message from each", async () => {
    const threadIds = [VALID_THREAD_ID, VALID_THREAD_ID_2];

    mockTokenAndSearch({
      data: {
        results: [{
          id: "101",
          properties: { smartspace_thread_ids: JSON.stringify(threadIds) },
        }],
      },
    });

    mockSmartSpaceMessages(() => ({
      data: {
        total: 1,
        data: [{
          id: "msg-1",
          createdAt: "2026-04-01T10:00:00Z",
          values: [
            { name: "email", type: "Input", value: TEST_EMAIL },
            { name: "prompt", type: "Input", value: [{ text: "What is LIFT?" }] },
          ],
        }],
      },
    }));

    const ctx = makeContext({ email: TEST_EMAIL, body: { action: "getHistory" } });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.threads).toHaveLength(2);
    expect(res.body.threads[0]).toMatchObject({
      threadId: expect.any(String),
      firstPrompt: "What is LIFT?",
      date: "2026-04-01T10:00:00Z",
    });
  });

  it("verifies email ownership and skips threads where email does not match", async () => {
    mockTokenAndSearch({
      data: {
        results: [{
          id: "101",
          properties: { smartspace_thread_ids: JSON.stringify([VALID_THREAD_ID]) },
        }],
      },
    });

    mockSmartSpaceMessages(() => ({
      data: {
        total: 1,
        data: [{
          id: "msg-1",
          createdAt: "2026-04-01T10:00:00Z",
          values: [
            { name: "email", type: "Input", value: "someone-else@example.com" },
            { name: "prompt", type: "Input", value: [{ text: "Hello" }] },
          ],
        }],
      },
    }));

    const ctx = makeContext({ email: TEST_EMAIL, body: { action: "getHistory" } });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.body.success).toBe(true);
    expect(res.body.threads).toHaveLength(0);
  });

  it("caps batch at 20 most recent threads", async () => {
    const manyIds = Array.from({ length: 30 }, (_, i) => {
      const hex = i.toString(16).padStart(8, "0");
      return `${hex}-0000-0000-0000-000000000000`;
    });

    mockTokenAndSearch({
      data: {
        results: [{
          id: "101",
          properties: { smartspace_thread_ids: JSON.stringify(manyIds) },
        }],
      },
    });

    mockSmartSpaceMessages(() => ({
      data: {
        total: 1,
        data: [{
          id: "msg-1",
          createdAt: "2026-04-01T10:00:00Z",
          values: [
            { name: "email", type: "Input", value: TEST_EMAIL },
            { name: "prompt", type: "Input", value: [{ text: "Hello" }] },
          ],
        }],
      },
    }));

    const ctx = makeContext({ email: TEST_EMAIL, body: { action: "getHistory" } });
    await proxyMain(ctx, sendResponse);

    const smartspaceCalls = mockGet.mock.calls.filter(([url]) =>
      url.includes("/messages")
    );
    expect(smartspaceCalls.length).toBeLessThanOrEqual(20);
  });

  it("returns error with success:false when HubSpot API fails", async () => {
    mockPost.mockImplementation((url) => {
      if (url.includes("oauth2")) {
        return Promise.resolve({ data: { access_token: "t", expires_in: 3600 } });
      }
      if (url.includes("contacts/search")) {
        return Promise.reject(new Error("HubSpot API timeout"));
      }
      return Promise.reject(new Error(`Unmocked POST: ${url}`));
    });

    const ctx = makeContext({ email: TEST_EMAIL, body: { action: "getHistory" } });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("HubSpot API timeout");
  });
});
