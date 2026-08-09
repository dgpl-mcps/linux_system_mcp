import { execSync } from "child_process";

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
  x?: number;
  y?: number;
  geometry: string;
  output?: string;
  error?: string;
}

export async function mouseExecute(params: MouseParams): Promise<MouseResult> {
  const geometry = "1920x1080 (1:1 canvas scaling)";
  const button = params.button || "left";

  try {
    if (params.action === "position") {
      const out = execSync("xdotool getmouselocation").toString().trim();
      const matchX = out.match(/x:(\d+)/);
      const matchY = out.match(/y:(\d+)/);
      return {
        success: true,
        action: "position",
        x: matchX ? parseInt(matchX[1], 10) : undefined,
        y: matchY ? parseInt(matchY[1], 10) : undefined,
        geometry,
        output: out,
      };
    }

    if (params.action === "move" || params.action === "click") {
      const targetX = params.x ?? 0;
      const targetY = params.y ?? 0;

      // First move to target coordinates
      if (params.x !== undefined && params.y !== undefined) {
        try {
          execSync(`ydotool mousemove --absolute -x ${targetX} -y ${targetY} 2>/dev/null || xdotool mousemove ${targetX} ${targetY}`);
        } catch {
          execSync(`xdotool mousemove ${targetX} ${targetY}`);
        }
      }

      if (params.action === "click") {
        const btnCode = button === "right" ? "0xC1" : button === "middle" ? "0xC2" : "0xC0";
        const xbtnCode = button === "right" ? "3" : button === "middle" ? "2" : "1";
        try {
          execSync(`ydotool click ${btnCode} 2>/dev/null || xdotool click ${xbtnCode}`);
        } catch {
          execSync(`xdotool click ${xbtnCode}`);
        }
      }

      return {
        success: true,
        action: params.action,
        x: targetX,
        y: targetY,
        geometry,
      };
    }

    throw new Error(`Invalid mouse action: ${params.action}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      action: params.action,
      geometry,
      error: msg,
    };
  }
}

export const mouseToolDefinition = {
  name: "mouse",
  description:
    "Control mouse cursor (move/click/position). Geometry: 1920x1080 (1:1 scaling). Note: Verify window focus & location before click. Use duration (100-300ms) & steps (5-10) for movement sensitivity/smoothness. Backend: ydotool & xdotool.",
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
        description: "Target X coordinate (canvas 1920x1080)",
      },
      y: {
        type: "number",
        description: "Target Y coordinate (canvas 1920x1080)",
      },
    },
    required: ["action"],
  },
};
