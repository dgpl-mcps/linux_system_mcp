import { spawn, execSync } from "child_process";
import { getInputBackend, InputDetectionResult } from "../utils/input-detect.js";
import { resolveSessionEnv } from "../utils/dialog-backend.js";

export interface MouseParams {
  action: "move" | "click" | "position";
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  duration?: number;
  steps?: number;
}

export interface MouseResult {
  success: boolean;
  action: string;
  backend: string;
  x?: number;
  y?: number;
  button?: string;
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

export async function mouse(params: MouseParams): Promise<MouseResult> {
  const backend = getBackend();
  
  if (!backend.available.xdotool && !backend.available.ydotool) {
    throw new Error("No mouse backend available (xdotool/ydotool)");
  }

  const cmd = backend.displayServer === "wayland" && backend.available.ydotool 
    ? "ydotool" 
    : "xdotool";

  switch (params.action) {
    case "move": {
      const { x, y, duration, steps } = params;
      const targetX = x ?? 0;
      const targetY = y ?? 0;
      const moveDuration = duration ?? 500;
      const moveSteps = steps ?? 10;
      
      if (moveSteps > 1 && moveDuration > 50) {
        const stepDelay = moveDuration / moveSteps;
        for (let i = 1; i <= moveSteps; i++) {
          const progress = i / moveSteps;
          await runCommand(cmd, ["mousemove", String(Math.round(targetX * progress)), String(Math.round(targetY * progress))], 2000);
          const jitter = Math.random() * stepDelay * 0.3;
          await sleep(stepDelay + jitter);
        }
      } else {
        await runCommand(cmd, ["mousemove", String(targetX), String(targetY)], 2000);
      }
      return { success: true, action: "move", backend: cmd, x: targetX, y: targetY };
    }

    case "click": {
      const button = params.button ?? "left";
      const buttonMap: Record<string, number> = { left: 1, middle: 2, right: 3 };
      
      if (params.x !== undefined && params.y !== undefined) {
        await runCommand(cmd, ["mousemove", String(params.x), String(params.y)], 2000);
        await sleep(50);
      }
      
      await runCommand(cmd, ["click", String(buttonMap[button])], 2000);
      return { success: true, action: "click", backend: cmd, button, x: params.x, y: params.y };
    }

    case "position": {
      if (cmd === "ydotool") {
        throw new Error("position not supported on Wayland without XWayland");
      }
      
      const result = await runCommand(cmd, ["getmouselocation", "--shell"], 2000);
      const xMatch = result.stdout.match(/X=(\d+)/);
      const yMatch = result.stdout.match(/Y=(\d+)/);
      
      if (!xMatch || !yMatch) {
        throw new Error(`Failed to parse position: ${result.stdout}`);
      }
      
      return { 
        success: true, 
        action: "position", 
        backend: cmd, 
        x: parseInt(xMatch[1], 10), 
        y: parseInt(yMatch[1], 10) 
      };
    }

    default:
      throw new Error(`Invalid action: ${params.action}`);
  }
}

export const mouseToolDefinition = {
  name: "mouse",
  description: "Control mouse cursor - move, click, or get position. " +
    "Parameters: action (move/click/position), x, y, button (left/right/middle), duration (ms, default: 500), steps (default: 10).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["move", "click", "position"],
        description: "Mouse action to perform"
      },
      x: { type: "number", description: "Target X coordinate (for move/click)" },
      y: { type: "number", description: "Target Y coordinate (for move/click)" },
      button: { 
        type: "string", 
        enum: ["left", "right", "middle"],
        description: "Mouse button (for click, default: left)" 
      },
      duration: { 
        type: "number", 
        description: "Movement duration in ms (anti-bot: slower = more human, default: 100)" 
      },
      steps: { 
        type: "number", 
        description: "Number of steps for movement (anti-bot: more = more human, default: 5)" 
      },
    },
    required: ["action"],
  },
};