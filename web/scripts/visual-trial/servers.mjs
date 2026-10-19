/** Starts the backend and Vite on free ports and stops exactly those processes again. */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_DIR = path.dirname(WEB_DIR);
const HOST = "127.0.0.1";

const READY_TIMEOUT_MS = 60 * 1000;
const READY_POLL_MS = 250;
const STOP_GRACE_MS = 5 * 1000;
const PORT_PROBE_TIMEOUT_MS = 1000;

const children = [];
let shutdownPromise = null;

/** Starts the real backend and Vite; resolves to the app URL. Call stopServers when done. */
export async function startServers() {
  if (shutdownPromise) throw new Error("cannot start servers after shutdown has begun");

  const [backendPort, vitePort] = [await freePort(), await freePort()];
  const backendUrl = `http://${HOST}:${backendPort}`;

  launch(
    "backend",
    backendPort,
    "python",
    [
      "-m",
      "uvicorn",
      "main:app",
      "--host",
      HOST,
      "--port",
      String(backendPort),
    ],
    REPO_DIR,
    {},
  );
  // Vite's file watcher misses edits on this mount, so every run needs a fresh server.
  launch(
    "vite",
    vitePort,
    process.execPath,
    [
      path.join(WEB_DIR, "node_modules/vite/bin/vite.js"),
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    WEB_DIR,
    { SOE_BACKEND: backendUrl },
  );

  await waitUntilReady(`${backendUrl}/api/health`);
  const appUrl = `http://${HOST}:${vitePort}`;
  await waitUntilReady(appUrl);

  return appUrl;
}

/** Stops the processes this module started and confirms their ports are free. */
export function stopServers() {
  shutdownPromise ??= stopStartedServers();
  return shutdownPromise;
}

async function stopStartedServers() {
  const started = children.splice(0);
  await Promise.all(started.map(stopChild));
  for (const { name, port } of started) {
    const stillOpen = await isOpen(port);
    console.error(`${name} port ${port} ${stillOpen ? "STILL OPEN" : "free"}`);
  }
}

function launch(name, port, command, args, cwd, extraEnv) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const lines = [];
  child.stderr.on("data", (chunk) => lines.push(String(chunk)));
  child.on("error", (error) => lines.push(String(error)));
  children.push({ name, port, child, lines });
  console.error(`started ${name} pid ${child.pid} on port ${port}`);
}

async function stopChild({ name, child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
  await exited;
  clearTimeout(timer);
  console.error(`stopped ${name} pid ${child.pid}`);
}

async function waitUntilReady(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const crashed = children.find(({ child }) => child.exitCode !== null);
    if (crashed) {
      throw new Error(`${crashed.name} exited early:\n${crashed.lines.join("").slice(-2000)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Connection failures are expected while the server starts listening.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`${url} was not ready within ${READY_TIMEOUT_MS / 1000} s`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Bounds port checks so cleanup can report an occupied or unresponsive port without hanging. */
export function isOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, HOST);
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
  });
}
