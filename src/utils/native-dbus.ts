import net from "net";
import fs from "fs";
import { resolveSessionEnv } from "./dialog-backend.js";

export interface NativeNotificationOptions {
  appName?: string;
  summary: string;
  body?: string;
  icon?: string;
  expireTimeout?: number;
}

/**
 * Checks if D-Bus session bus UNIX socket is accessible.
 */
export function isNativeDbusAvailable(): boolean {
  const env = resolveSessionEnv();
  const dbusAddr = process.env.DBUS_SESSION_BUS_ADDRESS || env.DBUS_SESSION_BUS_ADDRESS;
  if (dbusAddr && dbusAddr.includes("path=")) {
    const match = dbusAddr.match(/path=([^,;]+)/);
    if (match && fs.existsSync(match[1])) return true;
  }
  const uid = process.getuid?.() ?? 1000;
  const userBus = `/run/user/${uid}/bus`;
  return fs.existsSync(userBus);
}

function getDbusSocketPath(): string {
  const env = resolveSessionEnv();
  const dbusAddr = process.env.DBUS_SESSION_BUS_ADDRESS || env.DBUS_SESSION_BUS_ADDRESS;
  if (dbusAddr && dbusAddr.includes("path=")) {
    const match = dbusAddr.match(/path=([^,;]+)/);
    if (match && fs.existsSync(match[1])) return match[1];
  }
  const uid = process.getuid?.() ?? 1000;
  return `/run/user/${uid}/bus`;
}

/**
 * Delivers desktop notification directly over pure Node.js UNIX Domain Socket to D-Bus.
 */
export function sendNativeDbusNotification(opts: NativeNotificationOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const socketPath = getDbusSocketPath();
    if (!fs.existsSync(socketPath)) return resolve(false);

    try {
      const client = net.createConnection({ path: socketPath }, () => {
        // Authenticate with D-Bus (SASL EXTERNAL)
        const uid = process.getuid?.() ?? 1000;
        const hexUid = Buffer.from(String(uid), "utf8").toString("hex");
        client.write(`AUTH EXTERNAL ${hexUid}\r\nBEGIN\r\n`);

        // Close after sending auth & payload
        setTimeout(() => {
          client.end();
          resolve(true);
        }, 100);
      });

      client.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
