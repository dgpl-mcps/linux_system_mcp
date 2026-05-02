import { spawn, ChildProcess } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);
const SOCKET_PATH = join(homedir(), "linux-mcp-bg", "daemon.sock");
const DAEMON_SCRIPT = join(__dirname, "..", "daemon", "server.js");

let daemonProcess: ChildProcess | null = null;
let socketClient: any = null;

function getClient(): Promise<any> {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const client = new net.Socket();
    let data = "";
    client.connect(SOCKET_PATH, () => {
      resolve(client);
    });
    client.on("error", reject);
    client.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    client.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(data);
      }
    });
  });
}

function sendRequest(data: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const client = new net.Socket();
    let response = "";
    
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Connection timeout"));
    }, 5000);

    client.connect(SOCKET_PATH, () => {
      client.write(JSON.stringify(data));
    });

    client.on("data", (chunk: Buffer) => {
      response += chunk.toString();
    });

    client.on("close", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(response));
      } catch {
        reject(new Error("Invalid response"));
      }
    });

    client.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    await sendRequest({ action: "ping" });
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(): Promise<void> {
  if (daemonProcess) {
    return;
  }

  const daemonDir = join(homedir(), "linux-mcp-bg");
  
  daemonProcess = spawn("/bin/bash", ["-c", `cd "${daemonDir}" && nohup ${process.execPath} "${DAEMON_SCRIPT}" > /dev/null 2>&1 &`], {
    stdio: "ignore",
  });

  daemonProcess.unref();

  await new Promise((resolve, reject) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        await sendRequest({ action: "ping" });
        clearInterval(interval);
        resolve(true);
      } catch {
        if (attempts > 10) {
          clearInterval(interval);
          reject(new Error("Daemon failed to start"));
        }
      }
    }, 500);
  });
}

export async function stopDaemon(): Promise<void> {
  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
  }
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
  }
}

export async function ensureDaemon(): Promise<boolean> {
  try {
    await sendRequest({ action: "ping" });
    return true;
  } catch {
    try {
      await startDaemon();
      return true;
    } catch {
      return false;
    }
  }
}

export async function daemonRequest(data: object): Promise<any> {
  const running = await isDaemonRunning();
  if (!running) {
    throw new Error("Background daemon not running. Start with shell_background action:start or manually start the daemon.");
  }
  return sendRequest(data);
}

export const daemonManagerDefinition = {
  name: "daemon_manager",
  description: "Manage background daemon - start, stop, check status",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "status"],
        description: "Daemon action"
      },
    },
    required: ["action"],
  },
};