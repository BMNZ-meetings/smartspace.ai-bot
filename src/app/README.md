# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Todo:

- [x] remove `const userEmail = window.currentUserEmail || null;` from App.jsx
- [x] Use HubSpot's context parameter in `main.js`
- [x] Validate `action` in `main.js`
- [x] Set max length message
- [x] Validate `messageThreadId` format
- [ ] Remove logging from FE
- [x] Add rate limiting `main.js`

### Security
- [ ] Sanitize error responses in `main.js` — don't leak internal error details to client (lines 280, 439)
- [ ] Validate `payload` exists in `main.js` before accessing properties (line 66)
- [ ] Add periodic cleanup to `rateLimitMap` to prevent unbounded memory growth
- [ ] Filter thread recovery lookup by user email to prevent cross-user thread leakage (line 227)
- [ ] Remove unused `history` parameter from `smartspace.js` payload (or validate/cap its size)

### Efficiency
- [ ] Deduplicate concurrent token refresh requests in `main.js` `getAuthToken()`
- [ ] Add polling cleanup on component unmount in `ChatWidget.jsx`
- [x] Replace deprecated `onKeyPress` with `onKeyDown` in `ChatWidget.jsx`

### Improvements (from Smartspace reference app review)
- [x] Add `remarkGfm` to `ReactMarkdown` for tables, strikethrough, task lists
- [x] Add `target="_blank"` + `rel="noopener noreferrer"` to markdown links
- [x] Handle 429 rate limit response in `ChatWidget.jsx` with user-friendly message
- [x] Add React `ErrorBoundary` around `ChatWidget` in `App.jsx`
- [x] Replace deprecated `onKeyPress` with `onKeyDown` in `ChatWidget.jsx`
- [ ] Investigate SSE streaming responses instead of polling — requires scoping whether HubSpot serverless functions can proxy an SSE stream
- [ ] Consider React Query for state management — beneficial if expanding to multi-thread/sidebar UI, overkill for current single-widget scope
- [ ] Add Zod schema validation on SmartSpace API responses — catches breaking API changes early, moderate effort to implement