import { execSync, spawnSync } from "child_process";
import { resolveSessionEnv } from "./dialog-backend.js";
import { isNativeUinputAvailable } from "./native-uinput.js";

export type MouseBackend = "ydotool" | "xdotool" | "dotool" | "nativeUinput" | "none";
export type KeyboardBackend = "ydotool" | "xdotool" | "wtype" | "dotool" | "nativeUinput" | "none";

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
    nativeUinput: boolean;
    xrandr: boolean;
    xdpyinfo: boolean;
    hyprctl: boolean;
    swaymsg: boolean;
    wmctrl: boolean;
  };
}

export interface MousePositionInfo {
  x?: number;
  y?: number;
  screen?: number;
  windowId?: string;
  backendUsed?: string;
}

export interface WindowDetails {
  windowId: string;
  windowTitle?: string;
  windowClass?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isFocused: boolean;
}

const _cmdCache = new Map<string, { available: boolean; timestamp: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Executes a binary safely without shell string interpolation (prevents shell injection vulnerabilities).
 */
export function execInputCmdSafe(file: string, args: string[], timeoutMs: number = 5000): string {
  const sessionEnv = resolveSessionEnv();
  const combinedEnv = { ...process.env, ...sessionEnv };
  const res = spawnSync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: combinedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const errText = res.stderr ? res.stderr.trim() : `Process ${file} exited with code ${res.status}`;
    throw new Error(errText);
  }
  return res.stdout ? res.stdout.trim() : "";
}

/**
 * Legacy/convenience shell string executor (safely wrapped).
 */
export function execInputCmd(cmd: string): string {
  const sessionEnv = resolveSessionEnv();
  const combinedEnv = { ...process.env, ...sessionEnv };
  return execSync(cmd, { encoding: "utf8", timeout: 5000, env: combinedEnv }).trim();
}

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

/**
 * Calculates total combined multi-monitor bounding box resolution.
 */
export function detectScreenGeometry(): ScreenGeometry {
  // 1. Try hyprctl monitors (Hyprland Wayland)
  if (isCommandAvailable("hyprctl")) {
    try {
      const out = execInputCmdSafe("hyprctl", ["monitors", "-j"]);
      const monitors = JSON.parse(out);
      if (Array.isArray(monitors) && monitors.length > 0) {
        let maxRight = 0;
        let maxBottom = 0;
        for (const m of monitors) {
          const x = m.x ?? 0;
          const y = m.y ?? 0;
          const w = m.width ?? 1920;
          const h = m.height ?? 1080;
          if (x + w > maxRight) maxRight = x + w;
          if (y + h > maxBottom) maxBottom = y + h;
        }
        if (maxRight > 0 && maxBottom > 0) {
          return {
            width: maxRight,
            height: maxBottom,
            geometryString: `${maxRight}x${maxBottom} (multi-monitor combined)`,
          };
        }
      }
    } catch {}
  }

  // 2. Try swaymsg (Sway Wayland)
  if (isCommandAvailable("swaymsg")) {
    try {
      const out = execInputCmdSafe("swaymsg", ["-t", "get_outputs"]);
      const outputs = JSON.parse(out);
      if (Array.isArray(outputs) && outputs.length > 0) {
        let maxRight = 0;
        let maxBottom = 0;
        for (const o of outputs) {
          if (o.rect) {
            const x = o.rect.x ?? 0;
            const y = o.rect.y ?? 0;
            const w = o.rect.width ?? 1920;
            const h = o.rect.height ?? 1080;
            if (x + w > maxRight) maxRight = x + w;
            if (y + h > maxBottom) maxBottom = y + h;
          }
        }
        if (maxRight > 0 && maxBottom > 0) {
          return {
            width: maxRight,
            height: maxBottom,
            geometryString: `${maxRight}x${maxBottom} (sway multi-monitor)`,
          };
        }
      }
    } catch {}
  }

  // 3. Try xrandr (X11 / XWayland combined Virtual Screen Bounding Box)
  if (isCommandAvailable("xrandr")) {
    try {
      const out = execInputCmdSafe("xrandr", ["--current"]);
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
      const out = execInputCmdSafe("xdpyinfo", []);
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
    nativeUinput: isNativeUinputAvailable(),
    xrandr: isCommandAvailable("xrandr"),
    xdpyinfo: isCommandAvailable("xdpyinfo"),
    hyprctl: isCommandAvailable("hyprctl"),
    swaymsg: isCommandAvailable("swaymsg"),
    wmctrl: isCommandAvailable("wmctrl"),
  };

  let mouseBackend: MouseBackend = "none";
  let keyboardBackend: KeyboardBackend = "none";

  if (wayland) {
    if (available.ydotool) mouseBackend = "ydotool";
    else if (available.xdotool) mouseBackend = "xdotool";
    else if (available.dotool) mouseBackend = "dotool";
    else if (available.nativeUinput) mouseBackend = "nativeUinput";

    if (available.ydotool) keyboardBackend = "ydotool";
    else if (available.wtype) keyboardBackend = "wtype";
    else if (available.xdotool) keyboardBackend = "xdotool";
    else if (available.dotool) keyboardBackend = "dotool";
    else if (available.nativeUinput) keyboardBackend = "nativeUinput";
  } else {
    // X11
    if (available.xdotool) mouseBackend = "xdotool";
    else if (available.ydotool) mouseBackend = "ydotool";
    else if (available.dotool) mouseBackend = "dotool";
    else if (available.nativeUinput) mouseBackend = "nativeUinput";

    if (available.xdotool) keyboardBackend = "xdotool";
    else if (available.ydotool) keyboardBackend = "ydotool";
    else if (available.wtype) keyboardBackend = "wtype";
    else if (available.dotool) keyboardBackend = "dotool";
    else if (available.nativeUinput) keyboardBackend = "nativeUinput";
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

export function getCurrentMousePosition(): MousePositionInfo {
  const info = getInputBackend();

  // Attempt 1: xdotool
  if (info.available.xdotool) {
    try {
      const out = execInputCmdSafe("xdotool", ["getmouselocation", "--shell"]);
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
      const out = execInputCmdSafe("hyprctl", ["cursorpos"]);
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
      const out = execInputCmdSafe("ydotool", ["getmouselocation"]);
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

// ── WINDOW MANAGEMENT & TARGETING HELPERS ────────────────────────────────────

export function listWindows(): WindowDetails[] {
  const info = getInputBackend();
  const results: WindowDetails[] = [];

  // 1. Try Hyprland JSON client list
  if (info.available.hyprctl) {
    try {
      const out = execInputCmdSafe("hyprctl", ["clients", "-j"]);
      const clients = JSON.parse(out);
      if (Array.isArray(clients)) {
        for (const c of clients) {
          results.push({
            windowId: c.address,
            windowTitle: c.title,
            windowClass: c.class,
            x: c.at?.[0] ?? 0,
            y: c.at?.[1] ?? 0,
            width: c.size?.[0] ?? 0,
            height: c.size?.[1] ?? 0,
            isFocused: !!c.focusHistoryID && c.focusHistoryID === 0,
          });
        }
        if (results.length > 0) return results;
      }
    } catch {}
  }

  // 2. Try xdotool search
  if (info.available.xdotool) {
    try {
      let activeWinId = "";
      try {
        activeWinId = execInputCmdSafe("xdotool", ["getactivewindow"]);
      } catch {}

      const winIds = execInputCmdSafe("xdotool", ["search", "--onlyvisible", "--name", ""])
        .split("\n")
        .filter(Boolean);

      for (const id of winIds.slice(0, 50)) {
        try {
          const geomStr = execInputCmdSafe("xdotool", ["getwindowgeometry", id]);
          let title = "";
          try {
            title = execInputCmdSafe("xdotool", ["getwindowname", id]);
          } catch {}

          const matchPos = geomStr.match(/Position:\s*(\d+),(\d+)/);
          const matchGeo = geomStr.match(/Geometry:\s*(\d+)x(\d+)/);
          if (matchPos && matchGeo) {
            results.push({
              windowId: id,
              windowTitle: title || undefined,
              x: parseInt(matchPos[1], 10),
              y: parseInt(matchPos[2], 10),
              width: parseInt(matchGeo[1], 10),
              height: parseInt(matchGeo[2], 10),
              isFocused: activeWinId.trim() === id.trim(),
            });
          }
        } catch {}
      }
      if (results.length > 0) return results;
    } catch {}
  }

  return results;
}

export function searchWindow(query: { windowId?: string; windowTitle?: string; windowClass?: string }): WindowDetails | null {
  const windows = listWindows();
  if (windows.length === 0) return null;

  if (query.windowId) {
    const found = windows.find((w) => w.windowId.toLowerCase() === query.windowId!.toLowerCase());
    if (found) return found;
  }

  if (query.windowClass) {
    const qClass = query.windowClass.toLowerCase();
    const found = windows.find((w) => w.windowClass && w.windowClass.toLowerCase().includes(qClass));
    if (found) return found;
  }

  if (query.windowTitle) {
    const qTitle = query.windowTitle.toLowerCase();
    const found = windows.find((w) => w.windowTitle && w.windowTitle.toLowerCase().includes(qTitle));
    if (found) return found;
  }

  return null;
}

/**
 * Unminimizes, focuses, and activates a target window, inserting a 80ms settling pause.
 */
export function focusWindow(target: WindowDetails | string, settleDelayMs: number = 80): boolean {
  const info = getInputBackend();
  const windowId = typeof target === "string" ? target : target.windowId;
  let focused = false;

  // Hyprland
  if (info.available.hyprctl && windowId.startsWith("0x")) {
    try {
      execInputCmdSafe("hyprctl", ["dispatch", "focuswindow", `address:${windowId}`]);
      focused = true;
    } catch {}
  }

  // xdotool
  if (info.available.xdotool && !focused) {
    try {
      // 1. Unminimize / map window if hidden
      try {
        execInputCmdSafe("xdotool", ["windowmap", windowId]);
      } catch {}
      // 2. Activate & bring window to top
      execInputCmdSafe("xdotool", ["windowactivate", windowId]);
      focused = true;
    } catch {}
  }

  // wmctrl
  if (info.available.wmctrl && !focused) {
    try {
      execInputCmdSafe("wmctrl", ["-i", "-r", windowId, "-b", "remove,hidden"]);
      execInputCmdSafe("wmctrl", ["-i", "-a", windowId]);
      focused = true;
    } catch {}
  }

  // Synchronous settling delay to allow window manager layout redraw (default: 80ms)
  if (focused) {
    try {
      const delayMs = Math.max(10, settleDelayMs);
      const seconds = (delayMs / 1000).toFixed(3);
      spawnSync("sleep", [seconds], { stdio: "ignore" });
    } catch {}
  }

  return focused;
}

/**
 * Releases any stuck modifier keys across all available input backends (xdotool, ydotool, wtype, dotool).
 */
export function releaseStuckModifiers(): void {
  const info = getInputBackend();

  // 1. Try xdotool (X11 / XWayland)
  if (info.available.xdotool) {
    try {
      execInputCmdSafe("xdotool", [
        "keyup",
        "Control_L",
        "Control_R",
        "Alt_L",
        "Alt_R",
        "Shift_L",
        "Shift_R",
        "Super_L",
        "Super_R",
      ]);
    } catch {}
  }

  // 2. Try ydotool (uinput keyup release events for Ctrl, Alt, Shift, Meta)
  if (info.available.ydotool) {
    try {
      execInputCmdSafe("ydotool", ["key", "29:0", "97:0", "56:0", "100:0", "42:0", "54:0", "125:0", "126:0"]);
    } catch {}
  }

  // 3. Try wtype (Wayland modifier release)
  if (info.available.wtype) {
    try {
      execInputCmdSafe("wtype", ["-m", "ctrl", "-m", "alt", "-m", "shift", "-m", "super"]);
    } catch {}
  }

  // 4. Try dotool
  if (info.available.dotool) {
    try {
      execInputCmdSafe("sh", ["-c", 'echo "keyup ctrl alt shift super" | dotool']);
    } catch {}
  }
}
