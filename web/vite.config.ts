import { defineConfig, loadEnv } from "vite";

// IPv4 on both sides: Node resolves "localhost" to ::1, which the devcontainer port forward and uvicorn don't use.
// SOE_BACKEND overrides the backend URL (loadEnv also reads process.env, which has no types here).
const backend = loadEnv("", ".", "SOE_").SOE_BACKEND ?? "http://127.0.0.1:8000";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": backend, "/scenes": backend },
  },
});
