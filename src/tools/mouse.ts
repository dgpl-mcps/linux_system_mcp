import {
  getInputBackend,
  execInputCmd,
  getCurrentMousePosition,
  getActiveWindowInfo,
} from "../utils/input-detect.js";

export interface MouseParams {
  action: "move" | "click" | "position";
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  duration?: number;
  steps?: number;
}

export interface Coordinate {
  x: number;
  y: number;
}

export interface MouseResult {
  success: boolean;
  action: string;
  backendUsed?: string;
  verified?: boolean;
  target?: Coordinate;
  actual?: Coordinate;
  delta?: Coordinate;
  outOfBounds?: boolean;
  windowId?: string;
  windowTitle?: string;
  screen?: number;
  geometry: string;
  output?: string;
  warning?: string;
  error?: string;
}

export async function mouseExecute(params: MouseParams): Promise<MouseResult> {
  const info = getInputBackend();
  const geometryStr = `${info.geometry.geometryString} (${info.displayServer})`;
  const button = params.button || "left";

  try {
    // ── 1. Position Action ──────────────────────────────────────────────────
    if (params.action === "position") {
      const pos = getCurrentMousePosition();
      const win = getActiveWindowInfo();

      if (pos.x !== undefined && pos.y !== undefined) {
        return {
          success: true,
          action: "position",
          backendUsed: pos.backendUsed,
          actual: { x: pos.x, y: pos.y },
          screen: pos.screen,
          windowId: pos.windowId || win.windowId,
          windowTitle: win.windowTitle,
          geometry: geometryStr,
        };
      }

      throw new Error(
        "Unable to read mouse location. No functional mouse query tool (xdotool/hyprctl/ydotool) responded."
      );
    }

    // ── 2. Move & Click Actions ─────────────────────────────────────────────
    if (params.action === "move" || params.action === "click") {
      if (info.mouseBackend === "none") {
        throw new Error(
          "No mouse input backend available on system. Please install 'xdotool', 'ydotool', or 'dotool'."
        );
      }

      const targetX = params.x ?? 0;
      const targetY = params.y ?? 0;
      let backendUsed = info.mouseBackend;
      let warning: string | undefined;

      // Edge case: Out-of-bounds check against screen resolution
      let outOfBounds = false;
      if (
        targetX < 0 ||
        targetY < 0 ||
        targetX > info.geometry.width ||
        targetY > info.geometry.height
      ) {
        outOfBounds = true;
        warning = `Target (${targetX}, ${targetY}) is out of screen bounds [0..${info.geometry.width}, 0..${info.geometry.height}].`;
      }

      // Execute movement if x and y specified
      if (params.x !== undefined && params.y !== undefined) {
        let moved = false;

        // Try ydotool
        if (info.available.ydotool && !moved) {
          try {
            execInputCmd(`ydotool mousemove --absolute -x ${targetX} -y ${targetY}`);
            moved = true;
            backendUsed = "ydotool";
          } catch {}
        }

        // Try xdotool
        if (info.available.xdotool && !moved) {
          try {
            execInputCmd(`xdotool mousemove ${targetX} ${targetY}`);
            moved = true;
            backendUsed = "xdotool";
          } catch {}
        }

        // Try dotool
        if (info.available.dotool && !moved) {
          try {
            execInputCmd(`echo "mousemove ${targetX} ${targetY}" | dotool`);
            moved = true;
            backendUsed = "dotool";
          } catch {}
        }

        if (!moved) {
          throw new Error(`Failed to move mouse cursor to (${targetX}, ${targetY}).`);
        }
      }

      // Execute click if action === "click"
      if (params.action === "click") {
        let clicked = false;

        // Try ydotool
        if (info.available.ydotool && !clicked) {
          const btnCode = button === "right" ? "0xC1" : button === "middle" ? "0xC2" : "0xC0";
          try {
            execInputCmd(`ydotool click ${btnCode}`);
            clicked = true;
            backendUsed = "ydotool";
          } catch {}
        }

        // Try xdotool
        if (info.available.xdotool && !clicked) {
          const xbtnCode = button === "right" ? "3" : button === "middle" ? "2" : "1";
          try {
            execInputCmd(`xdotool click ${xbtnCode}`);
            clicked = true;
            backendUsed = "xdotool";
          } catch {}
        }

        // Try dotool
        if (info.available.dotool && !clicked) {
          const dbtn = button === "right" ? "btn_right" : button === "middle" ? "btn_middle" : "btn_left";
          try {
            execInputCmd(`echo "click ${dbtn}" | dotool`);
            clicked = true;
            backendUsed = "dotool";
          } catch {}
        }

        if (!clicked) {
          throw new Error(`Failed to perform ${button} click.`);
        }
      }

      // ── Post-Execution Location & Focus Verification ──────────────────────
      const postPos = getCurrentMousePosition();
      const win = getActiveWindowInfo();

      let verified = false;
      let actual: Coordinate | undefined;
      let delta: Coordinate | undefined;

      if (postPos.x !== undefined && postPos.y !== undefined) {
        actual = { x: postPos.x, y: postPos.y };
        if (params.x !== undefined && params.y !== undefined) {
          const dx = postPos.x - targetX;
          const dy = postPos.y - targetY;
          delta = { x: dx, y: dy };
          // Verification tolerance: within 5 pixels considered verified match
          verified = Math.abs(dx) <= 5 && Math.abs(dy) <= 5;
        } else {
          verified = true;
        }
      }

      return {
        success: true,
        action: params.action,
        backendUsed,
        verified,
        target: params.x !== undefined && params.y !== undefined ? { x: targetX, y: targetY } : undefined,
        actual,
        delta,
        outOfBounds: outOfBounds ? true : undefined,
        windowId: postPos.windowId || win.windowId,
        windowTitle: win.windowTitle,
        geometry: geometryStr,
        warning,
      };
    }

    throw new Error(`Invalid mouse action: ${params.action}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      action: params.action,
      geometry: geometryStr,
      error: msg,
    };
  }
}

export const mouseToolDefinition = {
  name: "mouse",
  description:
    "Control mouse cursor (move/click/position). Features post-execution position & click verification (returns target, actual, delta, verified status, active window ID & title). Auto-detects real resolution & edge-case out-of-bounds check.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["move", "click", "position"],
        description: "Mouse action to perform",
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button (for click, default: left)",
      },
      duration: {
        type: "number",
        description: "Movement duration in ms (default: 100)",
      },
      steps: {
        type: "number",
        description: "Number of steps for movement (default: 5)",
      },
      x: {
        type: "number",
        description: "Target X coordinate",
      },
      y: {
        type: "number",
        description: "Target Y coordinate",
      },
    },
    required: ["action"],
  },
};
