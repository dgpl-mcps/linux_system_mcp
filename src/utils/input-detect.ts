import { execSync, spawnSync } from "child_process";
import { resolveSessionEnv } from "./dialog-backend.js";

export type MouseBackend = "ydotool" | "xdotool" | "dotool" | "none";
export type KeyboardBackend = "ydotool" | "xdotool" | "wtype" | "dotool" | "none";

export interface ScreenGeometry {
  width: number;
  height: number;
  geometryString: string;
}

export interface InputDetectionResult {
  mouseBackend: MouseBackend;
  keyboardBackend: KeyboardBackend;
  displayServer: "x11" | "wayland" | "unknown";
  desktop: string;
  geometry: ScreenGeometry;
  available: {
    xdotool: boolean;
    ydotool: boolean;
    wtype: boolean;
    dotool: boolean;
    xrandr: boolean;
    xdpyinfo: boolean;
    hyprctl: boolean;
    swaymsg: boolean;
  };
}

export interface MousePositionInfo {
  x?: number;
  y?: number;
  screen?: number;
  windowId?: string;
  backendUsed?: string;
}

export interface WindowInfo {
  windowId?: string;
  windowTitle?: string;
}

const _cmdCache = new Map<string, { available: boolean; timestamp: number }>();
const CACHE_TTL_MS = 30_000;

function isCommandAvailable(cmd: string): boolean {
  const cached = _cmdCache.get(cmd);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.available;
  }
  try {
    const env = resolveSessionEnv();
    const res = spawnSync("which", [cmd], { stdio: "ignore", timeout: 2000, env: { ...process.env, ...env } });
    const available = res.status === 0;
    _cmdCache.set(cmd, { available, timestamp: now });
    return available;
  } catch {
    _cmdCache.set(cmd, { available: false, timestamp: now });
    return false;
  }
}

function getDesktopEnvironment(): string {
  const env = resolveSessionEnv();
  const xdgDesktop = process.env.XDG_CURRENT_DESKTOP || env.XDG_CURRENT_DESKTOP || "";
  const xdgSessionDesktop = process.env.XDG_SESSION_DESKTOP || env.XDG_SESSION_DESKTOP || "";
  const desktopSession = process.env.DESKTOP_SESSION || env.DESKTOP_SESSION || "";
  return xdgDesktop || xdgSessionDesktop || desktopSession || "unknown";
}

function isWayland(desktop: string, env: Record<string, string>): boolean {
  const lower = desktop.toLowerCase();
  const hasWayland = !!(process.env.WAYLAND_DISPLAY || env.WAYLAND_DISPLAY);
  return (
    hasWayland ||
    lower.includes("wayland") ||
    lower.includes("sway") ||
    lower.includes("hypr") ||
    (lower.includes("gnome") && hasWayland) ||
    (lower.includes("kde") && hasWayland)
  );
}

export function detectScreenGeometry(): ScreenGeometry {
  const env = { ...process.env, ...resolveSessionEnv() };

  // 1. Try hyprctl (Hyprland)
  if (isCommandAvailable("hyprctl")) {
    try {
      const out = execSync("hyprctl monitors", { encoding: "utf8", timeout: 2000, env }).trim();
      const match = out.match(/(\d+)x(\d+)@/);
      if (match) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        return { width, height, geometryString: `${width}x${height}` };
      }
    } catch {}
  }

  // 2. Try swaymsg (Sway)
  if (isCommandAvailable("swaymsg")) {
    try {
      const out = execSync("swaymsg -t get_outputs", { encoding: "utf8", timeout: 2000, env }).trim();
      const match = out.match(/"rect":\s*\{\s*"width":\s*(\d+),\s*"height":\s*(\d+)/);
      if (match) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        return { width, height, geometryString: `${width}x${height}` };
      }
    } catch {}
  }

  // 3. Try xrandr (X11 / XWayland)
  if (isCommandAvailable("xrandr")) {
    try {
      const out = execSync("xrandr --current", { encoding: "utf8", timeout: 2000, env }).trim();
      const match = out.match(/current\s+(\d+)\s+x\s+(\d+)/);
      if (match) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        return { width, height, geometryString: `${width}x${height}` };
      }
    } catch {}
  }

  // 4. Try xdpyinfo (X11)
  if (isCommandAvailable("xdpyinfo")) {
    try {
      const out = execSync("xdpyinfo", { encoding: "utf8", timeout: 2000, env }).trim();
      const match = out.match(/dimensions:\s+(\d+)x(\d+)\s+pixels/);
      if (match) {
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        return { width, height, geometryString: `${width}x${height}` };
      }
    } catch {}
  }

  // Fallback to standard 1080p
  return { width: 1920, height: 1080, geometryString: "1920x1080 (fallback)" };
}

export function detectInputBackend(): InputDetectionResult {
  const env = resolveSessionEnv();
  const desktop = getDesktopEnvironment();
  const wayland = isWayland(desktop, env);

  const available = {
    xdotool: isCommandAvailable("xdotool"),
    ydotool: isCommandAvailable("ydotool"),
    wtype: isCommandAvailable("wtype"),
    dotool: isCommandAvailable("dotool"),
    xrandr: isCommandAvailable("xrandr"),
    xdpyinfo: isCommandAvailable("xdpyinfo"),
    hyprctl: isCommandAvailable("hyprctl"),
    swaymsg: isCommandAvailable("swaymsg"),
  };

  let mouseBackend: MouseBackend = "none";
  let keyboardBackend: KeyboardBackend = "none";

  if (wayland) {
    if (available.ydotool) mouseBackend = "ydotool";
    else if (available.xdotool) mouseBackend = "xdotool";
    else if (available.dotool) mouseBackend = "dotool";

    if (available.ydotool) keyboardBackend = "ydotool";
    else if (available.wtype) keyboardBackend = "wtype";
    else if (available.xdotool) keyboardBackend = "xdotool";
    else if (available.dotool) keyboardBackend = "dotool";
  } else {
    // X11
    if (available.xdotool) mouseBackend = "xdotool";
    else if (available.ydotool) mouseBackend = "ydotool";
    else if (available.dotool) mouseBackend = "dotool";

    if (available.xdotool) keyboardBackend = "xdotool";
    else if (available.ydotool) keyboardBackend = "ydotool";
    else if (available.wtype) keyboardBackend = "wtype";
    else if (available.dotool) keyboardBackend = "dotool";
  }

  const geometry = detectScreenGeometry();

  return {
    mouseBackend,
    keyboardBackend,
    displayServer: wayland ? "wayland" : "x11",
    desktop,
    geometry,
    available,
  };
}

let _cachedDetection: InputDetectionResult | null = null;
let _cachedDetectionTime = 0;

export function getInputBackend(): InputDetectionResult {
  const now = Date.now();
  if (_cachedDetection && now - _cachedDetectionTime < CACHE_TTL_MS) {
    return _cachedDetection;
  }
  _cachedDetection = detectInputBackend();
  _cachedDetectionTime = now;
  return _cachedDetection;
}

export function execInputCmd(cmd: string): string {
  const sessionEnv = resolveSessionEnv();
  const combinedEnv = { ...process.env, ...sessionEnv };
  return execSync(cmd, { encoding: "utf8", timeout: 5000, env: combinedEnv }).trim();
}

export function getCurrentMousePosition(): MousePositionInfo {
  const info = getInputBackend();

  // Attempt 1: xdotool
  if (info.available.xdotool) {
    try {
      const out = execInputCmd("xdotool getmouselocation --shell");
      const matchX = out.match(/X=(\d+)/);
      const matchY = out.match(/Y=(\d+)/);
      const matchScreen = out.match(/SCREEN=(\d+)/);
      const matchWin = out.match(/WINDOW=(\d+)/);
      if (matchX && matchY) {
        return {
          x: parseInt(matchX[1], 10),
          y: parseInt(matchY[1], 10),
          screen: matchScreen ? parseInt(matchScreen[1], 10) : undefined,
          windowId: matchWin ? matchWin[1] : undefined,
          backendUsed: "xdotool",
        };
      }
    } catch {}
  }

  // Attempt 2: hyprctl
  if (info.available.hyprctl) {
    try {
      const out = execInputCmd("hyprctl cursorpos");
      const parts = out.split(",").map((s) => s.trim());
      if (parts.length === 2) {
        return {
          x: parseInt(parts[0], 10),
          y: parseInt(parts[1], 10),
          backendUsed: "hyprctl",
        };
      }
    } catch {}
  }

  // Attempt 3: ydotool
  if (info.available.ydotool) {
    try {
      const out = execInputCmd("ydotool getmouselocation");
      const matchX = out.match(/x:(\d+)/i) || out.match(/X=(\d+)/);
      const matchY = out.match(/y:(\d+)/i) || out.match(/Y=(\d+)/);
      if (matchX && matchY) {
        return {
          x: parseInt(matchX[1], 10),
          y: parseInt(matchY[1], 10),
          backendUsed: "ydotool",
        };
      }
    } catch {}
  }

  return {};
}

export function getActiveWindowInfo(): WindowInfo {
  const info = getInputBackend();
  if (info.available.xdotool) {
    try {
      const winId = execInputCmd("xdotool getactivewindow");
      let winTitle = "";
      if (winId) {
        try {
          winTitle = execInputCmd(`xdotool getwindowname ${winId}`);
        } catch {}
      }
      return { windowId: winId, windowTitle: winTitle || undefined };
    } catch {}
  }

  if (info.available.hyprctl) {
    try {
      const out = execInputCmd("hyprctl activewindow -j");
      const data = JSON.parse(out);
      return { windowId: data.address, windowTitle: data.title };
    } catch {}
  }

  return {};
}
