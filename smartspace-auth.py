import json
import requests
from azure.identity import ClientSecretCredential

TENANT_ID = ""
YOUR_APP_CLIENT_ID = ""          # your app registration (the calling app)
YOUR_APP_CLIENT_SECRET = ""      # secret for your calling app

SMARTSPACE_API_APP_ID = ""  # this is the app id / client id of the SmartSpace API app reg
SCOPE = f"api://{SMARTSPACE_API_APP_ID}/.default"

SMARTSPACE_WORKSPACE_ID = ""
SMARTSPACE_CHAT_API_URL = ""  # Get this from your admin portal -> AdminAPI docs -> CLI Setup

# Acquire app-only token
cred = ClientSecretCredential(
    tenant_id=TENANT_ID,
    client_id=YOUR_APP_CLIENT_ID,
    client_secret=YOUR_APP_CLIENT_SECRET,
)

token = cred.get_token(SCOPE)  # returns AccessToken
access_token = token.token
print(access_token)

# Call SmartSpace
headers = {
    "Authorization": f"Bearer {access_token}",
    "Content-Type": "application/json",
}

payload = {
    "workSpaceId": SMARTSPACE_WORKSPACE_ID,
    "inputs": [
        {
            "name": "prompt", 
            "value": [
                {"text": "Translate Hi to Spanish"}
            ]
        },
        {
        	"name":"extraInput",
        	"value":"someValue"
        }
    ],
}

resp = requests.post(f"{SMARTSPACE_CHAT_API_URL}/messages", headers=headers, json=payload)
print(resp.text)
resp.raise_for_status()

data = resp.json()
outputs = {v["name"]: v["value"] for v in data.get("values", []) if str(v.get("type")) == "2"}
print(json.dumps(outputs, indent=2))
