/**
 * Helper for testing the CJS serverless proxy with Vitest.
 *
 * The proxy uses `require("axios")` which resolves to its own node_modules,
 * bypassing Vitest's vi.mock. This helper patches the CJS require cache
 * so the proxy gets mock functions instead of the real axios.
 */
import { vi } from "vitest";
import { createRequire } from "module";
import Module from "module";

const proxyPath = new URL(
  "../../../serverless/smartspace-proxy/main.js",
  import.meta.url,
).pathname;

const proxyRequire = createRequire(proxyPath);
const axiosResolvedPath = proxyRequire.resolve("axios");

/**
 * Set up a fresh proxy import with mocked axios.
 * Call in beforeEach. Returns { proxy, mockPost, mockGet, mockPatch }.
 */
export async function setupProxy() {
  const mockPost = vi.fn();
  const mockGet = vi.fn();
  const mockPatch = vi.fn();
  const mockAxios = {
    post: mockPost,
    get: mockGet,
    patch: mockPatch,
    default: { post: mockPost, get: mockGet, patch: mockPatch },
  };

  // Clear the proxy and axios from the CJS require cache so we get fresh module state
  const cache = Module._cache;
  for (const key of Object.keys(cache)) {
    if (key.includes("smartspace-proxy") || key === axiosResolvedPath) {
      delete cache[key];
    }
  }

  // Inject mock axios into the CJS require cache
  cache[axiosResolvedPath] = {
    id: axiosResolvedPath,
    filename: axiosResolvedPath,
    loaded: true,
    exports: mockAxios,
  };

  // Set required env vars
  process.env.TENANT_ID = "test-tenant";
  process.env.YOUR_APP_CLIENT_ID = "test-client-id";
  process.env.YOUR_APP_CLIENT_SECRET = "test-secret";
  process.env.SMARTSPACE_API_APP_ID = "test-app-id";
  process.env.SMARTSPACE_WORKSPACE_ID = "ws-123";
  process.env.SMARTSPACE_CHAT_API_URL = "https://api.smartspace.test";
  process.env.bac_private_token = "test-hs-token";

  // Dynamic import to get fresh module-level state (cachedToken, tokenExpiry, etc.)
  // Vitest caches ESM imports, so we also need to invalidate that
  vi.resetModules();

  const proxy = await import("../../../serverless/smartspace-proxy/main.js");
  const proxyMain = proxy.main || proxy.default?.main;

  return { proxyMain, mockPost, mockGet, mockPatch };
}
