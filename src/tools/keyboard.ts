import { getInputBackend, execInputCmd } from "../utils/input-detect.js";

export interface KeyboardParams {
  action: "type" | "press" | "key_down" | "key_up";
  text?: string;
  key?: string;
  delay?: number;
}

export interface KeyboardResult {
  success: boolean;
  action: string;
  backendUsed?: string;
  output?: string;
  error?: string;
}

export async function keyboardExecute(params: KeyboardParams): Promise<KeyboardResult> {
  const info = getInputBackend();

  if (info.keyboardBackend === "none") {
    return {
      success: false,
      action: params.action,
      error:
        "No keyboard input backend available on system. Please install 'xdotool', 'ydotool', 'wtype', or 'dotool'.",
    };
  }

  try {
    // ── 1. Type Action ──────────────────────────────────────────────────────
    if (params.action === "type" && params.text) {
      const text = params.text;
      const escaped = text.replace(/'/g, "'\\''");
      let typed = false;
      let backendUsed = info.keyboardBackend;

      // Try ydotool
      if (info.available.ydotool && !typed) {
        try {
          execInputCmd(`ydotool type '${escaped}'`);
          typed = true;
          backendUsed = "ydotool";
        } catch {}
      }

      // Try wtype (Wayland native)
      if (info.available.wtype && !typed) {
        try {
          const msDelay = params.delay || 12;
          execInputCmd(`wtype -d ${msDelay} '${escaped}'`);
          typed = true;
          backendUsed = "wtype";
        } catch {}
      }

      // Try xdotool
      if (info.available.xdotool && !typed) {
        try {
          const msDelay = params.delay || 12;
          execInputCmd(`xdotool type --delay ${msDelay} '${escaped}'`);
          typed = true;
          backendUsed = "xdotool";
        } catch {}
      }

      // Try dotool
      if (info.available.dotool && !typed) {
        try {
          execInputCmd(`echo "type '${escaped}'" | dotool`);
          typed = true;
          backendUsed = "dotool";
        } catch {}
      }

      if (typed) {
        return { success: true, action: "type", backendUsed };
      }
      throw new Error("Failed to type text using available keyboard tools.");
    }

    // ── 2. Press Action ─────────────────────────────────────────────────────
    if (params.action === "press" && params.key) {
      const key = params.key;
      let pressed = false;
      let backendUsed = info.keyboardBackend;

      // Try ydotool
      if (info.available.ydotool && !pressed) {
        try {
          execInputCmd(`ydotool key '${key}'`);
          pressed = true;
          backendUsed = "ydotool";
        } catch {}
      }

      // Try wtype
      if (info.available.wtype && !pressed) {
        try {
          // Parse modifiers like Ctrl+C or Alt+F4 for wtype
          const parts = key.split("+");
          if (parts.length > 1) {
            const mods = parts.slice(0, -1).map((m) => `-M ${m.toLowerCase()}`).join(" ");
            const mainKey = parts[parts.length - 1];
            execInputCmd(`wtype ${mods} -k '${mainKey}'`);
          } else {
            execInputCmd(`wtype -k '${key}'`);
          }
          pressed = true;
          backendUsed = "wtype";
        } catch {}
      }

      // Try xdotool
      if (info.available.xdotool && !pressed) {
        try {
          execInputCmd(`xdotool key '${key}'`);
          pressed = true;
          backendUsed = "xdotool";
        } catch {}
      }

      // Try dotool
      if (info.available.dotool && !pressed) {
        try {
          execInputCmd(`echo "key '${key}'" | dotool`);
          pressed = true;
          backendUsed = "dotool";
        } catch {}
      }

      if (pressed) {
        return { success: true, action: "press", backendUsed };
      }
      throw new Error(`Failed to press key '${key}' using available keyboard tools.`);
    }

    throw new Error("Invalid keyboard action or missing required parameters (text for type, key for press)");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, action: params.action, error: msg };
  }
}

export const keyboardToolDefinition = {
  name: "keyboard",
  description:
    "Send keyboard events (type text or press shortcut keys). Auto-resolves active GUI session. Multi-backend fallbacks (ydotool, wtype, xdotool, dotool).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["type", "press", "key_down", "key_up"],
        description: "Keyboard action to perform",
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
    },
    required: ["action"],
  },
};
