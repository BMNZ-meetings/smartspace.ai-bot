import axios from "axios";

const API_BASE_URL = "/_hcms/api";

export const smartspaceService = {
  async sendChat(message, history = [], email = null, messageThreadId = null) {
    try {
      const payload = {
        message,
        history,
        email,
      };

      // Include messageThreadId if provided (for follow-up messages)
      if (messageThreadId) {
        payload.messageThreadId = messageThreadId;
      }

      console.log("[Service] Sending chat request:", payload);

      const response = await axios.post(`${API_BASE_URL}/smartspace-proxy`, {
        action: "chat",
        payload,
      });

      console.log("[Service] Chat response:", response.data);

      return response.data;
    } catch (error) {
      console.error("[Service] Error sending chat:", error);
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
