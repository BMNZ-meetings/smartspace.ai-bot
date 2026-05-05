import { vi } from "vitest";

export const smartspaceService = {
  sendChat: vi.fn(),
  getHistory: vi.fn(),
  getThread: vi.fn(),
  deleteThread: vi.fn(),
  getMessageStatus: vi.fn(),
};
