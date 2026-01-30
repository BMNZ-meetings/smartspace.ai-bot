const TENANT_ID = process.env.TENANT_ID;
const CLIENT_ID = process.env.YOUR_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUR_APP_CLIENT_SECRET;

const SMARTSPACE_APP_ID = process.env.SMARTSPACE_API_APP_ID;
const SMARTSPACE_WORKSPACE_ID = process.env.SMARTSPACE_WORKSPACE_ID;
const SMARTSPACE_API_URL = process.env.SMARTSPACE_CHAT_API_URL;

exports.main = async (context, sendResponse) => {
    const { body } = context;
    const { action, payload } = body;

    try {
        const axios = require('axios');
        var request = require('request');

        if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET || !SMARTSPACE_APP_ID || !SMARTSPACE_WORKSPACE_ID || !SMARTSPACE_API_URL) {
            return sendResponse({ body: { error: "Missing configuration environment variables." }, statusCode: 500 });
        }

        const getAccessToken = () => {
            var options = {
                'method': 'POST',
                'url': `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
                'headers': {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                form: {
                    'client_id': `${CLIENT_ID}`,
                    'client_secret': `${CLIENT_SECRET}`,
                    'grant_type': 'client_credentials',
                    'scope': `api://${SMARTSPACE_APP_ID}/.default`
                }
            };

            return new Promise((resolve, reject) => {
                request(options, (error, response) => {
                    if (error) return reject(error);
                    try {
                        const data = JSON.parse(response.body);
                        if (data.access_token) {
                            resolve(data.access_token);
                        } else {
                            reject(new Error("No access token in response: " + response.body));
                        }
                    } catch (e) {
                        reject(new Error("Failed to parse token response: " + e.message));
                    }
                });
            });
        };

        const accessToken = await getAccessToken();

        if (action === 'chat') {
            const userMessage = payload.message || "Hello";
            const userEmail = payload.email || "unknown@example.com";
            const messageThreadId = payload.messageThreadId;

            const smartspacePayload = {
                "workSpaceId": SMARTSPACE_WORKSPACE_ID,
                "inputs": [
                    { "name": "prompt", "value": [{ "text": userMessage }] },
                    { "name": "email", "value": userEmail }
                ]
            };

            if (messageThreadId) {
                smartspacePayload.messageThreadId = messageThreadId;
            }

            const apiResponse = await axios.post(`${SMARTSPACE_API_URL}/messages`, smartspacePayload, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const responseData = apiResponse.data;
            const outputs = {};
            if (responseData.values) {
                responseData.values.forEach(v => {
                    if (String(v.type) === "2") {
                        outputs[v.name] = v.value;
                    }
                });
            }

            sendResponse({
                body: {
                    success: true,
                    data: outputs,
                    messageThreadId: responseData.messageThreadId,
                    fullResponse: responseData
                },
                statusCode: 200
            });

        } else if (action === 'getStatus') {
            const { messageThreadId } = payload;
            if (!messageThreadId) {
                return sendResponse({ body: { error: "messageThreadId is required for getStatus" }, statusCode: 400 });
            }

            const apiResponse = await axios.get(`${SMARTSPACE_API_URL}/messages/${messageThreadId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const responseData = apiResponse.data;

            // Re-use the parsing logic for consistency
            const outputs = {};
            if (responseData.values) {
                responseData.values.forEach(v => {
                    if (String(v.type) === "2") {
                        outputs[v.name] = v.value;
                    }
                });
            }

            sendResponse({
                body: {
                    success: true,
                    data: outputs,
                    messageThreadId: responseData.messageThreadId,
                    fullResponse: responseData,
                    status: responseData.status // Assuming there's a status field
                },
                statusCode: 200
            });

        } else {
            sendResponse({ body: { error: "Unknown action" }, statusCode: 400 });
        }
    } catch (error) {
        console.error("Error executing function:", error.message);
        sendResponse({ body: { error: error.message, stack: error.stack }, statusCode: 500 });
    }
};

