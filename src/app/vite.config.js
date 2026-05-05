import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Wraps JS output in an IIFE to prevent global variable leaks (e.g. $ overwriting jQuery)
// while preserving CSS extraction as a separate file
function wrapInIIFE() {
  return {
    name: "wrap-iife",
    generateBundle(options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk") {
          chunk.code = `(function(){${chunk.code}})();\n`;
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Ensuring the output goes directly into the JS/CSS folders you use in HubSpot
    rollupOptions: {
      plugins: [wrapInIIFE()],
      output: {
        // Forces the main JS file to be named exactly this
        entryFileNames: `smartspace_chatbot.js`,
        // Ensures any code-splitting chunks have a predictable name
        chunkFileNames: `[name].js`,
        // Forces the CSS file to be named exactly this
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "index.css") return "smartspace_chatbot.css";
          return "[name].[ext]";
        },
      },
    },
  },
});
