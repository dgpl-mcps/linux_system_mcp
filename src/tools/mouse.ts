import { getInputBackend, execInputCmd } from "../utils/input-detect.js";

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
  backendUsed?: string;
  x?: number;
  y?: number;
  screen?: number;
  windowId?: string;
  geometry: string;
  output?: string;
  error?: string;
}

export async function mouseExecute(params: MouseParams): Promise<MouseResult> {
  const info = getInputBackend();
  const geometryStr = `${info.geometry.geometryString} (${info.displayServer})`;
  const button = params.button || "left";

  try {
    // ── 1. Position Action ──────────────────────────────────────────────────
    if (params.action === "position") {
      let x: number | undefined;
      let y: number | undefined;
      let screen: number | undefined;
      let windowId: string | undefined;
      let backendUsed = "unknown";
      let rawOutput = "";

      // Attempt 1: xdotool getmouselocation
      if (info.available.xdotool) {
        try {
          const out = execInputCmd("xdotool getmouselocation --shell");
          rawOutput = out;
          backendUsed = "xdotool";

          const matchX = out.match(/X=(\d+)/);
          const matchY = out.match(/Y=(\d+)/);
          const matchScreen = out.match(/SCREEN=(\d+)/);
          const matchWin = out.match(/WINDOW=(\d+)/);

          if (matchX) x = parseInt(matchX[1], 10);
          if (matchY) y = parseInt(matchY[1], 10);
          if (matchScreen) screen = parseInt(matchScreen[1], 10);
          if (matchWin) windowId = matchWin[1];
        } catch {}
      }

      // Attempt 2: hyprctl cursorpos (Hyprland Wayland fallback)
      if ((x === undefined || y === undefined) && info.available.hyprctl) {
        try {
          const out = execInputCmd("hyprctl cursorpos");
          rawOutput = out;
          backendUsed = "hyprctl";
          const parts = out.split(",").map((s) => s.trim());
          if (parts.length === 2) {
            x = parseInt(parts[0], 10);
            y = parseInt(parts[1], 10);
          }
        } catch {}
      }

      // Attempt 3: ydotool getmouselocation
      if ((x === undefined || y === undefined) && info.available.ydotool) {
        try {
          const out = execInputCmd("ydotool getmouselocation");
          rawOutput = out;
          backendUsed = "ydotool";
          const matchX = out.match(/x:(\d+)/i) || out.match(/X=(\d+)/);
          const matchY = out.match(/y:(\d+)/i) || out.match(/Y=(\d+)/);
          if (matchX) x = parseInt(matchX[1], 10);
          if (matchY) y = parseInt(matchY[1], 10);
        } catch {}
      }

      if (x !== undefined && y !== undefined) {
        return {
          success: true,
          action: "position",
          backendUsed,
          x,
          y,
          screen,
          windowId,
          geometry: geometryStr,
          output: rawOutput,
        };
      }

      throw new Error("Unable to read mouse location. No functional mouse query tool (xdotool/hyprctl/ydotool) responded.");
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

      // First move to target coordinates if x and y specified
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

      return {
        success: true,
        action: params.action,
        backendUsed,
        x: targetX,
        y: targetY,
        geometry: geometryStr,
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
    "Control mouse cursor (move/click/position). Auto-detects real screen resolution and session environment. Multi-backend fallbacks (ydotool, xdotool, hyprctl, dotool).",
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
        description: "Movement duration in ms (default: 100, recommended: 100-300ms for sensitivity/smoothness)",
      },
      steps: {
        type: "number",
        description: "Number of steps for movement (default: 5, recommended: 5-10)",
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
