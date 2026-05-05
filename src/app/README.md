# BMNZ Digital Mentor — chat widget

The Digital Mentor (DM) chat widget shipped on Mentor Hub. Authenticated mentors and mentees ask questions; the widget proxies through a HubSpot serverless function to the SmartSpace Chat API and renders the response.

## Architecture

```
Mentor Hub (HubSpot CMS)
        │
        ▼
ChatWidget.jsx ──── HubSpot membership context ─── userEmail
        │
        ▼
src/serverless/smartspace-proxy/main.js
        │  Auth: client credentials (Entra) → SmartSpace API
        │  Rate limit: 20 msg/min/user
        │  Two-step pattern: create thread → send message
        │
        ▼
SmartSpace Chat API
  POST /workspaces/{ws}/messagethreads        (create thread)
  POST /messages                              (send message)
  GET  /MessageThreads/{id}                   (poll isFlowRunning)
  GET  /messagethreads/{id}/messages?take=5   (poll for Response)
```

Proxy actions: `chat`, `getStatus`, `getHistory`, `getThread`, `deleteThread`. Thread IDs persist on the contact's `smartspace_thread_ids` property.

## Why polling, not SSE

HubSpot serverless functions are hard-killed at 10 seconds. SmartSpace's `/messages` endpoint can hold the connection open longer than that for streaming-enabled workspaces, so the proxy uses a tight 4-second timeout on `/messages` and falls through to a `polling_required` response. The widget polls `getStatus` every 1.5–3s until the bot response lands or `isFlowRunning` flips false. Polling budget is ~112s (40 attempts).

See `output/20260505_reply_stefan_streaming_findings.html` in the parent project for the streaming validation work against CreativeQ's test workspace.

## Build and deploy

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Build widget bundle | `npm run build` |
| Run tests | `npm test` |

The widget JS is built via Vite. CSS is hand-copied into HubSpot Design Manager. The serverless proxy is bundled separately under `src/serverless/smartspace-proxy/`.

## Outstanding

### Streaming
- [ ] Wire up progressive token rendering once CreativeQ confirms whether progressive Response writes (or `/MessageThreads/{id}/messages/stream` deltas during in-flight) are part of the streaming change. As of 5 May 2026 the test workspace emits final Response only, no deltas — see findings doc above.

### Security
- [ ] Sanitize error responses in `main.js` — don't leak internal error details to client
- [ ] Add periodic cleanup to `rateLimitMap` to prevent unbounded memory growth (partially done — pruned every 100 checks)
- [ ] Remove unused `history` parameter from `smartspace.js` payload (or validate/cap its size)

### Hygiene
- [ ] Remove logging from FE
- [ ] Add polling cleanup on `ChatWidget` unmount
- [ ] Deduplicate concurrent token refresh requests in `getAuthToken()` (partially done — promise singleton)

### Future
- [ ] Add Zod schema validation on SmartSpace API responses to catch breaking API changes early
- [ ] Consider React Query if expanding to multi-thread / sidebar UI (overkill for single-widget scope)
