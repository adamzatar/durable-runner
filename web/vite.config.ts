import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-server proxy for /api avoids needing CORS middleware on the Fastify
// server for local development.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
