import { defineConfig } from "vite";

// IPv4 on both sides: Node resolves "localhost" to ::1, which the devcontainer port forward and uvicorn don't use.
const backend = "http://127.0.0.1:8000";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": backend, "/scenes": backend },
  },
});
