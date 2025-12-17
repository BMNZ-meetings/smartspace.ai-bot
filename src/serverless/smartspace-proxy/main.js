const axios = require('axios');

const axios = require('axios');
const { ClientSecretCredential } = require('@azure/identity');

exports.main = async (context, sendResponse) => {
  const { body } = context;
  const { action, payload } = body;

  // Configuration from Environment Variables or Secrets
  const TENANT_ID = process.env.TENANT_ID;
  const CLIENT_ID = process.env.YOUR_APP_CLIENT_ID;
  const CLIENT_SECRET = process.env.YOUR_APP_CLIENT_SECRET;
  
  const SMARTSPACE_APP_ID = process.env.SMARTSPACE_API_APP_ID;
  const SMARTSPACE_WORKSPACE_ID = process.env.SMARTSPACE_WORKSPACE_ID;
  const SMARTSPACE_API_URL = process.env.SMARTSPACE_CHAT_API_URL; // e.g., https://api.smartspace.ai/v1

  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET || !SMARTSPACE_APP_ID || !SMARTSPACE_WORKSPACE_ID || !SMARTSPACE_API_URL) {
      return sendResponse({ body: { error: "Missing configuration secrets." }, statusCode: 500 });
  }

  const SCOPE = `api://${SMARTSPACE_APP_ID}/.default`;

  try {
    if (action === 'chat') {
        // 1. Authenticate with Azure AD
        console.log("Authenticating with Azure AD...");
        const credential = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET);
        const tokenResponse = await credential.getToken(SCOPE);
        const accessToken = tokenResponse.token;
        console.log("Authentication successful.");

        // 2. Prepare Payload for Smartspace
        // Assuming payload from client matches structure or is just the text content
        // This maps the client's simple input to the Smartspace complex structure if needed
        // Or passes through if the client already formats it.
        // Let's assume the client sends { "message": "Hi" } and we format it here to match smartspace-auth.py
        
        const userMessage = payload.message || "Hello";
        
        const smartspacePayload = {
            "workSpaceId": SMARTSPACE_WORKSPACE_ID,
            "inputs": [
                {
                    "name": "prompt",
                    "value": [
                        { "text": userMessage }
                    ]
                }
                // Add extraInput here if defined in requirements
            ]
        };
        
        // 3. Call Smartspace API
        console.log("Sending request to Smartspace...");
        const apiResponse = await axios.post(`${SMARTSPACE_API_URL}/messages`, smartspacePayload, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // 4. Process Response
        // smartspace-auth.py filters outputs for type "2". We can replicate that or return raw.
        // Let's return the simplified data as the python script does.
        const responseData = apiResponse.data;
        const outputs = {};
        
        if (responseData.values) {
             responseData.values.forEach(v => {
                 // Using loose comparison as python script uses str(v.get("type")) == "2"
                 if (String(v.type) === "2") {
                     outputs[v.name] = v.value;
                 }
             });
        }
        
        sendResponse({ body: { success: true, data: outputs, fullResponse: responseData }, statusCode: 200 });

    } else {
      sendResponse({ body: { error: "Unknown action" }, statusCode: 400 });
    }
  } catch (error) {
    console.error("Error executing function:", error.message);
    // Return detailed error for debugging (careful in production)
    sendResponse({ body: { error: error.message, stack: error.stack }, statusCode: 500 });
  }
};
