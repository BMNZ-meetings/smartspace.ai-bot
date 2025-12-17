import axios from 'axios';

const API_BASE_URL = '/_hcms/api'; // HubSpot serverless base path
// Adjust if you are testing locally without HubSpot proxy
// const API_BASE_URL = 'http://localhost:3000/api'; 

export const smartspaceService = {
  
  async sendChat(message, history = []) {
    try {
      const response = await axios.post(`${API_BASE_URL}/smartspace-proxy/proxy`, {
        action: 'chat',
        payload: {
          message,
          history
        }
      });
      return response.data;
    } catch (error) {
      console.error("Error sending chat:", error);
      throw error;
    }
  }
};
