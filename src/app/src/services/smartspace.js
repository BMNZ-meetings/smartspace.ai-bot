import axios from 'axios';

const API_BASE_URL = '/_hcms/api'; // HubSpot serverless base path
// Adjust if you are testing locally without HubSpot proxy
// const API_BASE_URL = 'http://localhost:3000/api'; 

export const smartspaceService = {

  async sendChat(message, history = [], email = null, messageThreadId = null) {
    try {
      const payload = {
        message,
        history,
        email
      };

      // Include messageThreadId if provided (for follow-up messages)
      if (messageThreadId) {
        payload.messageThreadId = messageThreadId;
      }

      const response = await axios.post(`/_hcms/api/smartspace-proxy`, {
        action: 'chat',
        payload
      });
      return response.data;
    } catch (error) {
      console.error("Error sending chat:", error);
      throw error;
    }
  },

  async getMessageStatus(messageThreadId) {
    try {
      const response = await axios.post(`/_hcms/api/smartspace-proxy`, {
        action: 'getStatus',
        payload: { messageThreadId }
      });
      return response.data;
    } catch (error) {
      console.error("Error getting message status:", error);
      throw error;
    }
  }
};

