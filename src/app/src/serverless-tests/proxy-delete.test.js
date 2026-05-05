import { describe, it, expect, beforeEach } from "vitest";
import { makeContext, makeSendResponse } from "../../test/mocks/hubspotContext.js";
import { setupProxy } from "../../test/mocks/proxyTestHelper.js";

const VALID_THREAD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const VALID_THREAD_ID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const TEST_EMAIL = "tester@example.com";

describe("deleteThread action", () => {
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
    mockPatch.mockResolvedValue({ data: {} });
  }

  it("removes thread ID from contact property and returns success", async () => {
    const existingIds = [VALID_THREAD_ID, VALID_THREAD_ID_2];

    mockTokenAndSearch({
      data: {
        results: [{
          id: "101",
          properties: { smartspace_thread_ids: JSON.stringify(existingIds) },
        }],
      },
    });

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "deleteThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.threadId).toBe(VALID_THREAD_ID);
  });

  it("returns 404 when HubSpot contact not found", async () => {
    mockTokenAndSearch({ data: { results: [] } });

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "deleteThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Contact not found");
  });

  it("returns success even when threadId was not in the list (no-op)", async () => {
    const existingIds = [VALID_THREAD_ID_2]; // Does not contain VALID_THREAD_ID

    mockTokenAndSearch({
      data: {
        results: [{
          id: "101",
          properties: { smartspace_thread_ids: JSON.stringify(existingIds) },
        }],
      },
    });

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "deleteThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // Should NOT have called patch since nothing changed
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid threadId format", async () => {
    mockTokenAndSearch({ data: { results: [] } });

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "deleteThread", payload: { threadId: "bad-id" } },
    });
    await proxyMain(ctx, sendResponse);

    const res = sendResponse.lastCall();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("Invalid threadId");
  });

  it("PATCHes HubSpot with the updated thread ID list", async () => {
    const existingIds = [VALID_THREAD_ID, VALID_THREAD_ID_2];

    mockTokenAndSearch({
      data: {
        results: [{
          id: "101",
          properties: { smartspace_thread_ids: JSON.stringify(existingIds) },
        }],
      },
    });

    const ctx = makeContext({
      email: TEST_EMAIL,
      body: { action: "deleteThread", payload: { threadId: VALID_THREAD_ID } },
    });
    await proxyMain(ctx, sendResponse);

    expect(mockPatch).toHaveBeenCalledTimes(1);
    const [patchUrl, patchBody] = mockPatch.mock.calls[0];
    expect(patchUrl).toContain("/crm/v3/objects/contacts/101");

    const patchedIds = JSON.parse(patchBody.properties.smartspace_thread_ids);
    expect(patchedIds).toEqual([VALID_THREAD_ID_2]);
    expect(patchedIds).not.toContain(VALID_THREAD_ID);
  });
});
