import { describe, it, expect, beforeEach } from "vitest";
import { makeContext, makeSendResponse } from "../../test/mocks/hubspotContext.js";
import { setupProxy } from "../../test/mocks/proxyTestHelper.js";

const VALID_THREAD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("proxy getStatus action", () => {
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

    // All getStatus tests need a token
    mockPost.mockImplementation((url) => {
      if (url.includes("oauth2")) {
        return Promise.resolve({
          data: { access_token: "test-token", expires_in: 3600 },
        });
      }
      return Promise.reject(new Error(`Unexpected POST to ${url}`));
    });
  });

  it("returns completed with message data when fresh output message exists", async () => {
    const now = new Date().toISOString();
    const outputValues = [
      { name: "Response", type: "Output", value: ["Here is the answer."] },
      { name: "email", type: "Input", value: "user@test.com" },
    ];

    mockGet.mockImplementation((url) => {
      if (url.includes("/MessageThreads/") && !url.includes("/messages")) {
        return Promise.resolve({ data: { isFlowRunning: false } });
      }
      if (url.includes("/messages")) {
        return Promise.resolve({
          data: {
            data: [{ id: "msg-out-001", createdAt: now, values: outputValues }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected GET to ${url}`));
    });

    const userMsgTime = new Date(Date.now() - 5000).toISOString();
    const ctx = makeContext({
      email: "user@test.com",
      body: {
        action: "getStatus",
        payload: {
          messageThreadId: VALID_THREAD_ID,
          lastUserMessageTime: userMsgTime,
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("completed");
    expect(res.body.data).toEqual(outputValues);
    expect(res.body.messageId).toBe("msg-out-001");
  });

  it("returns processing when no output message yet", async () => {
    mockGet.mockImplementation((url) => {
      if (url.includes("/MessageThreads/") && !url.includes("/messages")) {
        return Promise.resolve({ data: { isFlowRunning: true } });
      }
      if (url.includes("/messages")) {
        return Promise.resolve({
          data: {
            data: [{
              id: "msg-in-001",
              createdAt: new Date().toISOString(),
              values: [
                { name: "prompt", type: "Input", value: [{ text: "Hello" }] },
                { name: "email", type: "Input", value: "user@test.com" },
              ],
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected GET to ${url}`));
    });

    const ctx = makeContext({
      email: "user@test.com",
      body: {
        action: "getStatus",
        payload: {
          messageThreadId: VALID_THREAD_ID,
          lastUserMessageTime: new Date().toISOString(),
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("processing");
  });

  it("returns error_retry with success:false on API error", async () => {
    mockGet.mockRejectedValue(new Error("Network timeout"));

    const ctx = makeContext({
      email: "user@test.com",
      body: {
        action: "getStatus",
        payload: {
          messageThreadId: VALID_THREAD_ID,
          lastUserMessageTime: new Date().toISOString(),
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe("error_retry");
    expect(res.body.error).toBe("Network timeout");
  });

  it("returns 400 for invalid messageThreadId format", async () => {
    const ctx = makeContext({
      email: "user@test.com",
      body: {
        action: "getStatus",
        payload: {
          messageThreadId: "not-valid",
          lastUserMessageTime: new Date().toISOString(),
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid messageThreadId format");
  });
});
