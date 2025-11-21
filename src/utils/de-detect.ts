import { execSync } from "child_process";

export type DialogBackend = "kdialog" | "zenity" | "notify-send-only";

export interface DetectionResult {
  backend: DialogBackend;
  desktop: string;
  available: {
    kdialog: boolean;
    zenity: boolean;
    notifySend: boolean;
  };
  supportsDialogs: boolean;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getDesktopEnvironment(): string {
  const xdgDesktop = process.env.XDG_CURRENT_DESKTOP || "";
  const desktopSession = process.env.DESKTOP_SESSION || "";
  const xdgSessionDesktop = process.env.XDG_SESSION_DESKTOP || "";

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
  const notifySendAvailable = commandExists("notify-send");

  let backend: DialogBackend;
  let supportsDialogs = true;

  if (isKDE(desktop) && kdialogAvailable) {
    backend = "kdialog";
  } else if (zenityAvailable) {
    backend = "zenity";
  } else if (kdialogAvailable) {
    backend = "kdialog";
  } else if (notifySendAvailable) {
    // Fallback: notify-send only supports notifications, not dialogs
    backend = "notify-send-only";
    supportsDialogs = false;
  } else {
    throw new Error(
      "No notification backend available. Please install zenity, kdialog, or notify-send."
    );
  }

  return {
    backend,
    desktop,
    available: {
      kdialog: kdialogAvailable,
      zenity: zenityAvailable,
      notifySend: notifySendAvailable,
    },
    supportsDialogs,
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
