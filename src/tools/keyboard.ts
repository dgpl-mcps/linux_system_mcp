import {
  getInputBackend,
  execInputCmdSafe,
  searchWindow,
  focusWindow,
  releaseStuckModifiers,
  WindowDetails,
} from "../utils/input-detect.js";
import { nativeUinputKeyboardPress } from "../utils/native-uinput.js";

export interface KeyboardParams {
  action: "type" | "press" | "key_down" | "key_up" | "reset";
  text?: string;
  key?: string;
  delay?: number;
  windowId?: string;
  windowTitle?: string;
  windowClass?: string;
  focusWindow?: boolean;
  settleDelayMs?: number;
}

export interface KeyboardResult {
  success: boolean;
  action: string;
  backendUsed?: string;
  targetWindow?: WindowDetails;
  output?: string;
  error?: string;
}

export async function keyboardExecute(params: KeyboardParams): Promise<KeyboardResult> {
  const info = getInputBackend();

  // Handle explicit reset action to release any stuck modifier keys
  if (params.action === "reset") {
    releaseStuckModifiers();
    return {
      success: true,
      action: "reset",
      output: "All system modifier keys (Ctrl, Alt, Shift, Super) released.",
    };
  }

  if (info.keyboardBackend === "none") {
    return {
      success: false,
      action: params.action,
      error:
        "No keyboard input backend available on system. Please install 'xdotool', 'ydotool', 'wtype', or 'dotool'.",
    };
  }

  try {
    // ── 0. Resolve & Focus Target Window if specified ─────────────────────────
    let matchedWindow: WindowDetails | null = null;
    if (params.windowId || params.windowTitle || params.windowClass) {
      matchedWindow = searchWindow({
        windowId: params.windowId,
        windowTitle: params.windowTitle,
        windowClass: params.windowClass,
      });

      if (!matchedWindow) {
        throw new Error(
          `Target window not found matching filter (id: '${params.windowId || ""}', title: '${params.windowTitle || ""}', class: '${params.windowClass || ""}').`
        );
      }

      if (params.focusWindow !== false) {
        focusWindow(matchedWindow, params.settleDelayMs);
      }
    }

    // ── 1. Type Action ──────────────────────────────────────────────────────
    if (params.action === "type" && params.text) {
      const text = params.text;
      let typed = false;
      let backendUsed: string = info.keyboardBackend;

      // Try xdotool native window typing if window specified
      if (matchedWindow && info.available.xdotool) {
        try {
          const msDelay = params.delay || 12;
          execInputCmdSafe("xdotool", ["type", "--window", matchedWindow.windowId, "--delay", String(msDelay), text]);
          typed = true;
          backendUsed = "xdotool (window-native)";
        } catch {}
      }

      // Try ydotool
      if (info.available.ydotool && !typed) {
        try {
          execInputCmdSafe("ydotool", ["type", text]);
          typed = true;
          backendUsed = "ydotool";
        } catch {}
      }

      // Try wtype (Wayland native)
      if (info.available.wtype && !typed) {
        try {
          const msDelay = params.delay || 12;
          execInputCmdSafe("wtype", ["-d", String(msDelay), text]);
          typed = true;
          backendUsed = "wtype";
        } catch {}
      }

      // Try xdotool global
      if (info.available.xdotool && !typed) {
        try {
          const msDelay = params.delay || 12;
          execInputCmdSafe("xdotool", ["type", "--delay", String(msDelay), text]);
          typed = true;
          backendUsed = "xdotool";
        } catch {}
      }

      // Try dotool
      if (info.available.dotool && !typed) {
        try {
          execInputCmdSafe("sh", ["-c", `echo "type '${text.replace(/'/g, "'\\''")}'" | dotool`]);
          typed = true;
          backendUsed = "dotool";
        } catch {}
      }

      // Try nativeUinput
      if (info.available.nativeUinput && !typed) {
        let allTyped = true;
        for (const ch of text) {
          if (!nativeUinputKeyboardPress(ch)) allTyped = false;
        }
        if (allTyped) {
          typed = true;
          backendUsed = "nativeUinput";
        }
      }

      if (typed) {
        return { success: true, action: "type", backendUsed, targetWindow: matchedWindow || undefined };
      }
      throw new Error("Failed to type text using available keyboard tools.");
    }

    // ── 2. Press Action ─────────────────────────────────────────────────────
    if (params.action === "press" && params.key) {
      const key = params.key;
      let pressed = false;
      let backendUsed: string = info.keyboardBackend;

      // Try xdotool native window keypress
      if (matchedWindow && info.available.xdotool) {
        try {
          execInputCmdSafe("xdotool", ["key", "--window", matchedWindow.windowId, key]);
          pressed = true;
          backendUsed = "xdotool (window-native)";
        } catch {}
      }

      // Try ydotool
      if (info.available.ydotool && !pressed) {
        try {
          execInputCmdSafe("ydotool", ["key", key]);
          pressed = true;
          backendUsed = "ydotool";
        } catch {}
      }

      // Try wtype
      if (info.available.wtype && !pressed) {
        try {
          const parts = key.split("+");
          if (parts.length > 1) {
            const mods = parts.slice(0, -1).flatMap((m) => ["-M", m.toLowerCase()]);
            const mainKey = parts[parts.length - 1];
            execInputCmdSafe("wtype", [...mods, "-k", mainKey]);
          } else {
            execInputCmdSafe("wtype", ["-k", key]);
          }
          pressed = true;
          backendUsed = "wtype";
        } catch {}
      }

      // Try xdotool global
      if (info.available.xdotool && !pressed) {
        try {
          execInputCmdSafe("xdotool", ["key", key]);
          pressed = true;
          backendUsed = "xdotool";
        } catch {}
      }

      // Try dotool
      if (info.available.dotool && !pressed) {
        try {
          execInputCmdSafe("sh", ["-c", `echo "key '${key}'" | dotool`]);
          pressed = true;
          backendUsed = "dotool";
        } catch {}
      }

      if (pressed) {
        return { success: true, action: "press", backendUsed, targetWindow: matchedWindow || undefined };
      }
      throw new Error(`Failed to press key '${key}' using available keyboard tools.`);
    }

    throw new Error("Invalid keyboard action or missing required parameters (text for type, key for press)");
  } catch (error) {
    // Auto-release any stuck modifier keys on failure
    releaseStuckModifiers();
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, action: params.action, error: msg };
  }
}

export const keyboardToolDefinition = {
  name: "keyboard",
  description:
    "Send keyboard events (type text or press shortcut keys). Defaults to active system focus. Optionally pass application window parameters (windowTitle, windowClass, windowId) to target & auto-focus a specific app window. Features action=reset to release stuck modifier keys.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["type", "press", "key_down", "key_up", "reset"],
        description: "Keyboard action to perform (use action=reset if modifier keys get stuck)",
      },
      text: {
        type: "string",
        description: "Text to type (for action=type)",
      },
      key: {
        type: "string",
        description: "Key or shortcut combination to press (e.g. Return, Ctrl+C, Alt+F4)",
      },
      delay: {
        type: "number",
        description: "Delay between keystrokes in ms (default: 12)",
      },
      windowTitle: {
        type: "string",
        description: "Target window by title substring (e.g. 'Chrome', 'Terminal', 'VS Code')",
      },
      windowClass: {
        type: "string",
        description: "Target window by application class (e.g. 'google-chrome', 'code')",
      },
      windowId: {
        type: "string",
        description: "Target window by specific Window ID (e.g. '0x3a00006')",
      },
      focusWindow: {
        type: "boolean",
        description: "If true, automatically focus/bring target window to front before typing (default: true)",
      },
      settleDelayMs: {
        type: "number",
        description: "Custom window manager focus settling delay in ms (default: 80ms, pass 150-300ms for heavy apps)",
      },
    },
    required: ["action"],
  },
};
