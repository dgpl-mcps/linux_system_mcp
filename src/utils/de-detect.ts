import { execSync } from "child_process";
import { isQuiet } from "../config.js";

export type DialogBackend = "kdialog" | "zenity" | "notify-send-only" | "none";

export interface DetectionResult {
  backend: DialogBackend;
  desktop: string;
  available: {
    kdialog: boolean;
    zenity: boolean;
    notifySend: boolean;
    dbusSend: boolean;
  };
  supportsDialogs: boolean;
  supportsNotify: boolean;
}

function commandExists(cmd: string): boolean {
  try {
    // Use a timeout so a slow/broken PATH doesn't stall startup
    execSync(`which ${cmd}`, { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function getDesktopEnvironment(): string {
  const xdgDesktop = process.env.XDG_CURRENT_DESKTOP || "";
  const xdgSessionDesktop = process.env.XDG_SESSION_DESKTOP || "";
  const desktopSession = process.env.DESKTOP_SESSION || "";
  return xdgDesktop || xdgSessionDesktop || desktopSession || "unknown";
}

function isKDE(desktop: string): boolean {
  const lower = desktop.toLowerCase();
  return lower.includes("kde") || lower.includes("plasma");
}

export function detectDialogBackend(): DetectionResult {
  const desktop = getDesktopEnvironment();
  const kdialogAvailable = commandExists("kdialog");
  const zenityAvailable = commandExists("zenity");
  const notifySendAvail = commandExists("notify-send");
  const dbusSendAvail = commandExists("dbus-send");

  let backend: DialogBackend;
  let supportsDialogs = true;
  // We can notify even without a full dialog backend
  const supportsNotify = kdialogAvailable || zenityAvailable || notifySendAvail || dbusSendAvail;

  if (isKDE(desktop) && kdialogAvailable) {
    backend = "kdialog";
  } else if (zenityAvailable) {
    backend = "zenity";
  } else if (kdialogAvailable) {
    backend = "kdialog";
  } else if (notifySendAvail) {
    backend = "notify-send-only";
    supportsDialogs = false;
  } else if (dbusSendAvail) {
    // dbus-send can deliver notifications directly — no dialog support
    backend = "notify-send-only"; // reuse tier; dialogs not supported
    supportsDialogs = false;
  } else {
    // Nothing at all — degrade gracefully instead of throwing
    if (!isQuiet()) {
      process.stderr.write(
        "[linux-system-mcp] WARNING: No notification backend found. " +
        "Install kdialog, zenity, libnotify (notify-send), or dbus-send.\n"
      );
    }
    backend = "none" as DialogBackend;
    supportsDialogs = false;
  }

  return {
    backend,
    desktop,
    available: {
      kdialog: kdialogAvailable,
      zenity: zenityAvailable,
      notifySend: notifySendAvail,
      dbusSend: dbusSendAvail,
    },
    supportsDialogs,
    supportsNotify,
  };
}

let cachedResult: DetectionResult | null = null;

export function getDialogBackend(): DetectionResult {
  if (!cachedResult) {
    cachedResult = detectDialogBackend();
  }
  return cachedResult;
}

export function clearCache(): void {
  cachedResult = null;
}
