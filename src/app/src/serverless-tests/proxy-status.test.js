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

  it("returns streaming when output exists AND flow still running", async () => {
    // Streaming-aware path: SmartSpace writes the Response value progressively
    // to the persisted message. While isFlowRunning is true, we want the proxy
    // to surface the current partial Response so the widget can render it.
    const now = new Date().toISOString();
    const partialOutputValues = [
      { name: "Response", type: "Output", value: "Cashflow forecasting helps small business" },
      { name: "email", type: "Input", value: "user@test.com" },
    ];

    mockGet.mockImplementation((url) => {
      if (url.includes("/MessageThreads/") && !url.includes("/messages")) {
        return Promise.resolve({ data: { isFlowRunning: true } });
      }
      if (url.includes("/messages")) {
        return Promise.resolve({
          data: {
            data: [{ id: "msg-streaming-001", createdAt: now, values: partialOutputValues }],
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
          lastUserMessageTime: new Date(Date.now() - 5000).toISOString(),
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("streaming");
    expect(res.body.data).toEqual(partialOutputValues);
    expect(res.body.messageId).toBe("msg-streaming-001");
  });

  it("returns growing data on repeat polls of the same message during streaming", async () => {
    // The bug we fixed: previously when lastMessageId matched the current
    // message id, the proxy returned status:"stale" with empty data, killing
    // any chance of progressive rendering. Now it must keep returning the
    // updated Response value while flow is still running.
    const now = new Date().toISOString();
    const grownOutputValues = [
      {
        name: "Response",
        type: "Output",
        value: "Cashflow forecasting helps small business owners in New Zealand see what money is likely to come in",
      },
      { name: "email", type: "Input", value: "user@test.com" },
    ];

    mockGet.mockImplementation((url) => {
      if (url.includes("/MessageThreads/") && !url.includes("/messages")) {
        return Promise.resolve({ data: { isFlowRunning: true } });
      }
      if (url.includes("/messages")) {
        return Promise.resolve({
          data: {
            data: [{ id: "msg-streaming-001", createdAt: now, values: grownOutputValues }],
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
          lastUserMessageTime: new Date(Date.now() - 5000).toISOString(),
          // Widget is telling us "I've already seen msg-streaming-001 — that
          // used to make us return empty data; now we keep returning the
          // current value because Response has grown."
          lastMessageId: "msg-streaming-001",
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("streaming");
    expect(res.body.data).toEqual(grownOutputValues);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.messageId).toBe("msg-streaming-001");
  });

  it("returns completed on the final poll of a streaming message", async () => {
    // After the stream finishes, isFlowRunning flips false. Even if the widget
    // has been seeing the same messageId all along (lastMessageId === current),
    // the proxy must signal completion so the widget can stop polling and
    // append the final message to the messages array.
    const now = new Date().toISOString();
    const finalOutputValues = [
      { name: "Response", type: "Output", value: "Final complete answer." },
      { name: "email", type: "Input", value: "user@test.com" },
    ];

    mockGet.mockImplementation((url) => {
      if (url.includes("/MessageThreads/") && !url.includes("/messages")) {
        return Promise.resolve({ data: { isFlowRunning: false } });
      }
      if (url.includes("/messages")) {
        return Promise.resolve({
          data: {
            data: [{ id: "msg-streaming-001", createdAt: now, values: finalOutputValues }],
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
          lastUserMessageTime: new Date(Date.now() - 5000).toISOString(),
          lastMessageId: "msg-streaming-001",
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.data).toEqual(finalOutputValues);
  });

  it("returns stale with empty data when message is older than user's send", async () => {
    // Stale fallback: the only message in the thread is older than the user's
    // last send (e.g. they hit retry but nothing new was created). Flow is also
    // stopped. Tell the widget to stop polling.
    const oldMsgTime = new Date(Date.now() - 60_000).toISOString();
    const userMsgTime = new Date(Date.now() - 1000).toISOString();
    const oldOutputValues = [
      { name: "Response", type: "Output", value: "Old answer from before user's send" },
      { name: "email", type: "Input", value: "user@test.com" },
    ];

    mockGet.mockImplementation((url) => {
      if (url.includes("/MessageThreads/") && !url.includes("/messages")) {
        return Promise.resolve({ data: { isFlowRunning: false } });
      }
      if (url.includes("/messages")) {
        return Promise.resolve({
          data: {
            data: [{ id: "msg-old-001", createdAt: oldMsgTime, values: oldOutputValues }],
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
          lastUserMessageTime: userMsgTime,
        },
      },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("stale");
    expect(res.body.data).toEqual([]);
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
