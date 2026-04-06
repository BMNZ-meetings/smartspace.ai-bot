// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatWidget from "../ChatWidget";
import { smartspaceService } from "../../services/smartspace";

vi.mock("../../services/smartspace", () => ({
  smartspaceService: {
    sendChat: vi.fn(),
    getHistory: vi.fn(),
    getThread: vi.fn(),
    deleteThread: vi.fn(),
    getMessageStatus: vi.fn(),
  },
}));

describe("ChatWidget integration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();

    // Default: history loads successfully with no threads
    smartspaceService.getHistory.mockResolvedValue({
      success: true,
      threads: [],
    });

    // Stub clipboard
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders textarea and send button", async () => {
    await act(async () => {
      render(<ChatWidget />);
    });

    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("send button is disabled when textarea is empty", async () => {
    await act(async () => {
      render(<ChatWidget />);
    });

    const sendBtn = screen.getByLabelText("Send message");
    expect(sendBtn).toBeDisabled();
  });

  it("sending a message adds user message and bot reply to chat", async () => {
    smartspaceService.sendChat.mockResolvedValue({
      success: true,
      messageThreadId: "abc-123",
    });
    smartspaceService.getMessageStatus.mockResolvedValue({
      status: "completed",
      data: [{
        values: { Response: { value: "Bot reply" } },
        name: "Response",
        type: "2",
        value: "Bot reply",
      }],
      messageId: "msg-1",
    });

    await act(async () => {
      render(<ChatWidget />);
    });

    const textarea = screen.getByPlaceholderText("Ask anything");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(textarea, "Hello bot");
    await user.click(screen.getByLabelText("Send message"));

    // User message appears immediately (optimistic)
    expect(screen.getByText("Hello bot")).toBeInTheDocument();

    // Wait for bot reply to appear
    await vi.waitFor(() => {
      expect(screen.getByText("Bot reply")).toBeInTheDocument();
    });
  });

  it("shows error message when sendChat throws", async () => {
    smartspaceService.sendChat.mockRejectedValue(new Error("Network failure"));

    await act(async () => {
      render(<ChatWidget />);
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const textarea = screen.getByPlaceholderText("Ask anything");

    await user.type(textarea, "Hello");
    await user.click(screen.getByLabelText("Send message"));

    // The widget shows a fallback error message
    await vi.waitFor(() => {
      expect(
        screen.getByText(/having trouble connecting/i),
      ).toBeInTheDocument();
    });
  });

  it("startNewConversation clears messages", async () => {
    smartspaceService.sendChat.mockResolvedValue({
      success: true,
      messageThreadId: "thread-new",
    });
    smartspaceService.getMessageStatus.mockResolvedValue({
      status: "completed",
      data: [{
        name: "Response",
        type: "2",
        value: "Some reply",
      }],
      messageId: "msg-2",
    });

    // History with one thread so the history icon appears
    smartspaceService.getHistory.mockResolvedValue({
      success: true,
      threads: [{ threadId: "thread-new", firstPrompt: "Hello", date: new Date().toISOString() }],
    });

    await act(async () => {
      render(<ChatWidget />);
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    // Send a message first
    await user.type(screen.getByPlaceholderText("Ask anything"), "Hello");
    await user.click(screen.getByLabelText("Send message"));

    await vi.waitFor(() => {
      expect(screen.getByText("Some reply")).toBeInTheDocument();
    });

    // Open history panel to access "New conversation" button
    const historyToggle = screen.getByLabelText("Conversation history");
    await user.click(historyToggle);

    // Click new conversation in the history panel
    const newConvBtn = screen.getByText("New conversation");
    await user.click(newConvBtn);

    // Chat messages should be cleared (history panel may still show "Hello" as thread prompt)
    expect(screen.queryByText("Some reply")).not.toBeInTheDocument();
    const chatBody = document.querySelector(".chat-body");
    expect(chatBody.textContent).not.toContain("Hello");
  });

  it("history error shows retry button", async () => {
    // Force the panel open and make history fail
    localStorage.setItem("dm_history_open", "true");
    smartspaceService.getHistory.mockRejectedValue(new Error("Server down"));

    await act(async () => {
      render(<ChatWidget />);
    });

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to load history/i)).toBeInTheDocument();
      expect(screen.getByText("Try again")).toBeInTheDocument();
    });

    // Clean up
    localStorage.removeItem("dm_history_open");
  });

  it("toast appears on copy and clears after timeout", async () => {
    smartspaceService.sendChat.mockResolvedValue({
      success: true,
      messageThreadId: "thread-toast",
    });
    smartspaceService.getMessageStatus.mockResolvedValue({
      status: "completed",
      data: [{
        name: "Response",
        type: "2",
        value: "Copy me",
      }],
      messageId: "msg-3",
    });

    await act(async () => {
      render(<ChatWidget />);
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    // Send a message to get the copy conversation button to appear
    await user.type(screen.getByPlaceholderText("Ask anything"), "test");
    await user.click(screen.getByLabelText("Send message"));

    await vi.waitFor(() => {
      expect(screen.getByText("Copy me")).toBeInTheDocument();
    });

    // Click copy conversation button
    const copyBtn = screen.getByLabelText("Copy conversation");
    await user.click(copyBtn);

    // Toast should appear
    await vi.waitFor(() => {
      expect(screen.getByText("Copied to clipboard")).toBeInTheDocument();
    });

    // Advance timers past the 3000ms toast timeout
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    expect(screen.queryByText("Copied to clipboard")).not.toBeInTheDocument();
  });
});
