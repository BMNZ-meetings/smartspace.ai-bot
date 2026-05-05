import { describe, it, expect, beforeEach } from "vitest";
import { makeContext, makeSendResponse } from "../../test/mocks/hubspotContext.js";
import { setupProxy } from "../../test/mocks/proxyTestHelper.js";

describe("proxy auth and validation", () => {
  let proxyMain;
  let mockPost;
  let sendResponse;

  beforeEach(async () => {
    const setup = await setupProxy();
    proxyMain = setup.proxyMain;
    mockPost = setup.mockPost;
    sendResponse = makeSendResponse();
  });

  it("returns 400 for invalid action name", async () => {
    const ctx = makeContext({
      email: "user@test.com",
      body: { action: "notARealAction", payload: {} },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid action");
  });

  it("returns 400 when payload is missing for non-getHistory action", async () => {
    const ctx = makeContext({
      email: "user@test.com",
      body: { action: "chat" },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Missing payload");
  });

  it("returns 401 when context.contact is null", async () => {
    const ctx = makeContext({
      body: { action: "chat", payload: { message: "hello" } },
      contact: null,
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 when contact exists but email is missing", async () => {
    const ctx = makeContext({
      body: { action: "chat", payload: { message: "hello" } },
      contact: { firstname: "Test" },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.body.message).toContain("No email");
  });

  it("getHistory action succeeds without payload", async () => {
    mockPost.mockImplementation((url) => {
      if (url.includes("oauth2")) {
        return Promise.resolve({
          data: { access_token: "test-token", expires_in: 3600 },
        });
      }
      if (url.includes("hubapi.com")) {
        return Promise.resolve({ data: { results: [] } });
      }
      return Promise.reject(new Error(`Unexpected POST to ${url}`));
    });

    const ctx = makeContext({
      email: "user@test.com",
      body: { action: "getHistory" },
    });

    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).not.toBe(400);
    expect(res.body.success).toBe(true);
  });
});
