import { spawnSync, execSync } from "child_process";
import { isQuiet } from "../config.js";

export type InputBackend = "xdotool" | "ydotool" | "uinput" | "none";

export interface InputDetectionResult {
  backend: InputBackend;
  displayServer: "x11" | "wayland" | "unknown";
  desktop: string;
  available: {
    xdotool: boolean;
    ydotool: boolean;
    scrot: boolean;
    import: boolean;
    grim: boolean;
    slop: boolean;
  };
  supportsInput: boolean;
  supportsScreenshot: boolean;
}

// ============ COMMAND AVAILABILITY CACHE ============

const _cmdAvailCache = new Map<string, { result: boolean; ts: number }>();
const CMD_AVAIL_TTL_MS = 30_000;

function isCommandAvailable(cmd: string): boolean {
  const cached = _cmdAvailCache.get(cmd);
  const now = Date.now();
  if (cached && now - cached.ts < CMD_AVAIL_TTL_MS) return cached.result;
  try {
    const { status, error } = spawnSync("which", [cmd], { stdio: "ignore", timeout: 2000 });
    const result = !error && status === 0;
    _cmdAvailCache.set(cmd, { result, ts: now });
    return result;
  } catch {
    _cmdAvailCache.set(cmd, { result: false, ts: now });
    return false;
  }
}

function getDesktopEnvironment(): string {
  const xdgDesktop = process.env.XDG_CURRENT_DESKTOP || "";
  const xdgSessionDesktop = process.env.XDG_SESSION_DESKTOP || "";
  const desktopSession = process.env.DESKTOP_SESSION || "";
  return xdgDesktop || xdgSessionDesktop || desktopSession || "unknown";
}

function isWayland(desktop: string): boolean {
  const lower = desktop.toLowerCase();
  const hasWayland = !!process.env.WAYLAND_DISPLAY;
  return lower.includes("wayland") || lower.includes("sway") || 
         lower.includes("hypr") || (lower.includes("gnome") && hasWayland) ||
         (lower.includes("kde") && hasWayland);
}

export function detectInputBackend(): InputDetectionResult {
  const desktop = getDesktopEnvironment();
  const isWaylandSession = isWayland(desktop);
  
  // Check available tools
  const xdotoolAvailable = isCommandAvailable("xdotool");
  const ydotoolAvailable = isCommandAvailable("ydotool");
  const scrotAvailable = isCommandAvailable("scrot");
  const importAvailable = isCommandAvailable("import"); // ImageMagick
  const grimAvailable = isCommandAvailable("grim");
  const slopAvailable = isCommandAvailable("slop");

  let backend: InputBackend;
  let supportsInput = true;
  let supportsScreenshot = true;

  // Determine input backend based on display server
  if (isWaylandSession) {
    if (ydotoolAvailable) {
      backend = "ydotool";
    } else if (xdotoolAvailable) {
      // xdotool can work with XWayland
      backend = "xdotool";
    } else {
      backend = "none";
      supportsInput = false;
    }
  } else {
    // X11
    if (xdotoolAvailable) {
      backend = "xdotool";
    } else if (ydotoolAvailable) {
      backend = "ydotool";
    } else {
      backend = "none";
      supportsInput = false;
    }
  }

  // Screenshot support
  const screenshotAvailable = scrotAvailable || importAvailable || grimAvailable;
  if (!screenshotAvailable) {
    supportsScreenshot = false;
  }

  if (!isQuiet()) {
    process.stderr.write(
      `[linux-system-mcp] Input backend: ${backend} | Display: ${isWaylandSession ? "wayland" : "x11"} | ` +
      `xdotool: ${xdotoolAvailable}, ydotool: ${ydotoolAvailable}, ` +
      `scrot: ${scrotAvailable}, grim: ${grimAvailable}\n`
    );
  }

  return {
    backend,
    displayServer: isWaylandSession ? "wayland" : "x11",
    desktop,
    available: {
      xdotool: xdotoolAvailable,
      ydotool: ydotoolAvailable,
      scrot: scrotAvailable,
      import: importAvailable,
      grim: grimAvailable,
      slop: slopAvailable,
    },
    supportsInput,
    supportsScreenshot,
  };
}

let cachedResult: InputDetectionResult | null = null;

export function getInputBackend(): InputDetectionResult {
  if (!cachedResult) {
    cachedResult = detectInputBackend();
  }
  return cachedResult;
}

export function clearInputCache(): void {
  cachedResult = null;
}