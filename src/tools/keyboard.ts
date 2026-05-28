import { spawn } from "child_process";
import { getInputBackend, InputDetectionResult } from "../utils/input-detect.js";
import { resolveSessionEnv } from "../utils/dialog-backend.js";

export interface KeyboardParams {
  action: "type" | "press";
  text?: string;
  key?: string;
  modifiers?: string[];
  delay?: number;
  jitter?: number;
}

export interface KeyboardResult {
  success: boolean;
  action: string;
  backend: string;
  charsTyped?: number;
  key?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getBackend(): InputDetectionResult {
  return getInputBackend();
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number = 10000
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const sessionEnv = resolveSessionEnv();
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DISPLAY: sessionEnv.DISPLAY || ":0",
        WAYLAND_DISPLAY: sessionEnv.WAYLAND_DISPLAY || "",
      },
      detached: false,
    });

    let stdout = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        resolve({ stdout: stdout.trim(), exitCode: 124 });
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", () => {});
    
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: stdout.trim(), exitCode: code ?? 0 });
      }
    });

    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: "", exitCode: 1 });
      }
    });
  });
}

export async function keyboard(params: KeyboardParams): Promise<KeyboardResult> {
  const backend = getBackend();
  
  if (!backend.available.xdotool && !backend.available.ydotool) {
    throw new Error("No keyboard backend available (xdotool/ydotool)");
  }

  const cmd = backend.displayServer === "wayland" && backend.available.ydotool 
    ? "ydotool" 
    : "xdotool";

  switch (params.action) {
    case "type": {
      const text = params.text ?? "";
      const delay = params.delay ?? 150;
      const jitter = params.jitter ?? 0.3;
      let charsTyped = 0;
      
      for (const char of text) {
        const escapedChar = char === "'" ? "\\'" : char;
        await runCommand(cmd, ["type", escapedChar], 2000);
        charsTyped++;
        
        if (delay > 0) {
          const jitterAmount = delay * jitter * (Math.random() * 2 - 1);
          await sleep(delay + jitterAmount);
        }
      }
      
      return { success: true, action: "type", backend: cmd, charsTyped };
    }

    case "press": {
      const { key, modifiers } = params;
      let keySeq: string[];
      
      if (modifiers && modifiers.length > 0) {
        const modMap: Record<string, string> = {
          ctrl: "ctrl", control: "ctrl",
          shift: "shift", alt: "alt",
          super: "super", win: "super", meta: "super",
        };
        const mods = modifiers.map(m => modMap[m.toLowerCase()] || m);
        keySeq = [...mods, (key ?? "").toLowerCase()];
      } else {
        keySeq = [(key ?? "").toLowerCase()];
      }

      await runCommand(cmd, ["key", ...keySeq], 2000);
      return { success: true, action: "press", backend: cmd, key };
    }

    default:
      throw new Error(`Invalid action: ${params.action}`);
  }
}

export const keyboardToolDefinition = {
  name: "keyboard",
  description: "Control keyboard - type text or press keys. " +
    "Parameters: action (type/press), text (for type), key, modifiers, delay (default: 150ms), jitter (0-1).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["type", "press"],
        description: "Keyboard action to perform"
      },
      text: { type: "string", description: "Text to type (for type action)" },
      key: { type: "string", description: "Key to press (for press action, e.g., 'a', 'enter', 'esc')" },
      modifiers: { 
        type: "array", 
        items: { type: "string" },
        description: "Modifier keys (e.g., ['ctrl', 'shift'] for press action)" 
      },
      delay: { 
        type: "number", 
        description: "Delay between chars in ms (anti-bot, default: 100)" 
      },
      jitter: { 
        type: "number", 
        description: "Random jitter factor 0-1 (anti-bot, default: 0.3)" 
      },
    },
    required: ["action"],
  },
};