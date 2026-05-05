import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { smartspaceService } from "../smartspace";

vi.mock("axios");

describe("smartspaceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sendChat", () => {
    it("posts correct action and payload without threadId", async () => {
      axios.post.mockResolvedValue({ data: { success: true } });

      await smartspaceService.sendChat("hello", [{ role: "user", text: "hi" }]);

      expect(axios.post).toHaveBeenCalledWith("/_hcms/api/smartspace-proxy", {
        action: "chat",
        payload: {
          message: "hello",
          history: [{ role: "user", text: "hi" }],
        },
      });
    });

    it("includes messageThreadId when provided", async () => {
      axios.post.mockResolvedValue({ data: { success: true } });

      await smartspaceService.sendChat("follow-up", [], "thread-42");

      expect(axios.post).toHaveBeenCalledWith("/_hcms/api/smartspace-proxy", {
        action: "chat",
        payload: {
          message: "follow-up",
          history: [],
          messageThreadId: "thread-42",
        },
      });
    });

    it("throws on network error", async () => {
      axios.post.mockRejectedValue(new Error("Network Error"));

      await expect(smartspaceService.sendChat("hello")).rejects.toThrow("Network Error");
    });
  });

  describe("getHistory", () => {
    it("posts with empty payload", async () => {
      axios.post.mockResolvedValue({ data: { success: true, threads: [] } });

      await smartspaceService.getHistory();

      expect(axios.post).toHaveBeenCalledWith("/_hcms/api/smartspace-proxy", {
        action: "getHistory",
        payload: {},
      });
    });
  });

  describe("getThread", () => {
    it("posts with threadId in payload", async () => {
      axios.post.mockResolvedValue({ data: { success: true, messages: [] } });

      await smartspaceService.getThread("thread-99");

      expect(axios.post).toHaveBeenCalledWith("/_hcms/api/smartspace-proxy", {
        action: "getThread",
        payload: { threadId: "thread-99" },
      });
    });
  });

  describe("deleteThread", () => {
    it("posts with threadId in payload", async () => {
      axios.post.mockResolvedValue({ data: { success: true } });

      await smartspaceService.deleteThread("thread-99");

      expect(axios.post).toHaveBeenCalledWith("/_hcms/api/smartspace-proxy", {
        action: "deleteThread",
        payload: { threadId: "thread-99" },
      });
    });

    it("throws on error (not swallowed)", async () => {
      axios.post.mockRejectedValue(new Error("Server Error"));

      await expect(smartspaceService.deleteThread("thread-99")).rejects.toThrow("Server Error");
    });
  });

  describe("getMessageStatus", () => {
    it("includes lastMessageId only when provided", async () => {
      axios.post.mockResolvedValue({ data: { status: "completed" } });

      // Without lastMessageId
      await smartspaceService.getMessageStatus("thread-1", "2026-01-01T00:00:00Z");
      expect(axios.post).toHaveBeenCalledWith("/_hcms/api/smartspace-proxy", {
        action: "getStatus",
        payload: {
          messageThreadId: "thread-1",
          lastUserMessageTime: "2026-01-01T00:00:00Z",
        },
      });

      vi.clearAllMocks();

      // With lastMessageId
      await smartspaceService.getMessageStatus("thread-1", "2026-01-01T00:00:00Z", "msg-5");
      expect(axios.post).toHaveBeenCalledWith("/_hcms/api/smartspace-proxy", {
        action: "getStatus",
        payload: {
          messageThreadId: "thread-1",
          lastUserMessageTime: "2026-01-01T00:00:00Z",
          lastMessageId: "msg-5",
        },
      });
    });

    it("throws on error", async () => {
      axios.post.mockRejectedValue(new Error("Timeout"));

      await expect(
        smartspaceService.getMessageStatus("thread-1", "2026-01-01T00:00:00Z"),
      ).rejects.toThrow("Timeout");
    });
  });

  describe("all methods", () => {
    it("all POST to /_hcms/api/smartspace-proxy", async () => {
      axios.post.mockResolvedValue({ data: { success: true, threads: [], messages: [] } });

      await smartspaceService.sendChat("hi");
      await smartspaceService.getHistory();
      await smartspaceService.getThread("t1");
      await smartspaceService.deleteThread("t1");
      await smartspaceService.getMessageStatus("t1", "2026-01-01T00:00:00Z");

      for (const call of axios.post.mock.calls) {
        expect(call[0]).toBe("/_hcms/api/smartspace-proxy");
      }
      expect(axios.post).toHaveBeenCalledTimes(5);
    });
  });
});
