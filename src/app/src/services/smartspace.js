import axios from "axios";

const API_BASE_URL = "/_hcms/api";

export const smartspaceService = {
  async sendChat(message, history = [], messageThreadId = null) {
    try {
      const payload = {
        message,
        history,
      };

      // Include messageThreadId if provided (for follow-up messages)
      if (messageThreadId) {
        payload.messageThreadId = messageThreadId;
      }

      const response = await axios.post(`${API_BASE_URL}/smartspace-proxy`, {
        action: "chat",
        payload,
      });

      return response.data;
    } catch (error) {
      console.error("[Service] Error sending chat:", error);
      throw error;
    }
  },

  async getHistory() {
    try {
      const response = await axios.post(`${API_BASE_URL}/smartspace-proxy`, {
        action: "getHistory",
        payload: {},
      });
      return response.data;
    } catch (error) {
      console.error("[Service] Error fetching history:", error);
      throw error;
    }
  },

  async getThread(threadId) {
    try {
      const response = await axios.post(`${API_BASE_URL}/smartspace-proxy`, {
        action: "getThread",
        payload: { threadId },
      });
      return response.data;
    } catch (error) {
      console.error("[Service] Error fetching thread:", error);
      throw error;
    }
  },

  async deleteThread(threadId) {
    try {
      const response = await axios.post(`${API_BASE_URL}/smartspace-proxy`, {
        action: "deleteThread",
        payload: { threadId },
      });
      return response.data;
    } catch (error) {
      console.error("[Service] Error deleting thread:", error);
      throw error;
    }
  },

  async getMessageStatus(messageThreadId, sentTime, lastMessageId = null) {
    try {
      const payload = {
        messageThreadId,
        lastUserMessageTime: sentTime,
      };

      // Include lastMessageId if provided to prevent duplicates
      if (lastMessageId) {
        payload.lastMessageId = lastMessageId;
      }

      const response = await axios.post(`${API_BASE_URL}/smartspace-proxy`, {
        action: "getStatus",
        payload,
      });

      return response.data;
    } catch (error) {
      console.error("[Service] Error getting message status:", error);
      throw error;
    }
  },
};
