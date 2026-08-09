import { execSync } from "child_process";

export interface KeyboardParams {
  action: "type" | "press" | "key_down" | "key_up";
  text?: string;
  key?: string;
  delay?: number;
}

export interface KeyboardResult {
  success: boolean;
  action: string;
  output?: string;
  error?: string;
}

export async function keyboardExecute(params: KeyboardParams): Promise<KeyboardResult> {
  try {
    if (params.action === "type" && params.text) {
      const escaped = params.text.replace(/'/g, "'\\''");
      try {
        execSync(`ydotool type '${escaped}' 2>/dev/null || xdotool type --delay ${params.delay || 12} '${escaped}'`);
      } catch {
        execSync(`xdotool type --delay ${params.delay || 12} '${escaped}'`);
      }
      return { success: true, action: "type" };
    }

    if (params.action === "press" && params.key) {
      try {
        execSync(`ydotool key '${params.key}' 2>/dev/null || xdotool key '${params.key}'`);
      } catch {
        execSync(`xdotool key '${params.key}'`);
      }
      return { success: true, action: "press" };
    }

    throw new Error(`Invalid keyboard action or missing required parameters`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, action: params.action, error: msg };
  }
}

export const keyboardToolDefinition = {
  name: "keyboard",
  description:
    "Send keyboard events (type text or press shortcut keys). Uses ydotool (Wayland uinput) & xdotool.",
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
