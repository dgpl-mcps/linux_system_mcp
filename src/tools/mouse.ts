import {
  getInputBackend,
  execInputCmdSafe,
  getCurrentMousePosition,
  listWindows,
  searchWindow,
  focusWindow,
  WindowDetails,
} from "../utils/input-detect.js";

export interface MouseParams {
  action: "move" | "click" | "double_click" | "scroll" | "drag" | "position";
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  direction?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
  steps?: number;
  windowId?: string;
  windowTitle?: string;
  windowClass?: string;
  relativeToWindow?: boolean;
  focusWindow?: boolean;
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
  targetWindowRelative?: Coordinate;
  actual?: Coordinate;
  delta?: Coordinate;
  outOfBounds?: boolean;
  targetWindow?: WindowDetails;
  currentWindowId?: string;
  currentWindowTitle?: string;
  screen?: number;
  geometry: string;
  warning?: string;
  error?: string;
}

function sleepSync(ms: number): void {
  try {
    const seconds = (ms / 1000).toFixed(3);
    execInputCmdSafe("sleep", [seconds]);
  } catch {}
}

export async function mouseExecute(params: MouseParams): Promise<MouseResult> {
  const info = getInputBackend();
  const geometryStr = `${info.geometry.geometryString} (${info.displayServer})`;
  const button = params.button || "left";

  try {
    // ── 0. Resolve Window Target if specified ─────────────────────────────────
    let matchedWindow: WindowDetails | null = null;
    if (params.windowId || params.windowTitle || params.windowClass) {
      matchedWindow = searchWindow({
        windowId: params.windowId,
        windowTitle: params.windowTitle,
        windowClass: params.windowClass,
      });

      if (!matchedWindow) {
        throw new Error(
          `Target window not found matching filter (id: '${params.windowId || ""}', title: '${params.windowTitle || ""}', class: '${params.windowClass || ""}'). Open windows: ${listWindows().map((w) => `'${w.windowTitle || w.windowClass || w.windowId}'`).join(", ")}`
        );
      }

      // Auto-focus target window if focusWindow is not explicitly false
      if (params.focusWindow !== false) {
        focusWindow(matchedWindow);
      }
    }

    // ── 1. Position Action ──────────────────────────────────────────────────
    if (params.action === "position") {
      const pos = getCurrentMousePosition();

      if (pos.x !== undefined && pos.y !== undefined) {
        return {
          success: true,
          action: "position",
          backendUsed: pos.backendUsed,
          actual: { x: pos.x, y: pos.y },
          screen: pos.screen,
          currentWindowId: pos.windowId || matchedWindow?.windowId,
          currentWindowTitle: matchedWindow?.windowTitle,
          targetWindow: matchedWindow || undefined,
          geometry: geometryStr,
        };
      }

      throw new Error(
        "Unable to read mouse location. No functional mouse query tool (xdotool/hyprctl/ydotool) responded."
      );
    }

    // ── 2. Scroll Action ────────────────────────────────────────────────────
    if (params.action === "scroll") {
      if (info.mouseBackend === "none") {
        throw new Error("No mouse input backend available for scrolling.");
      }

      const dir = params.direction || "down";
      const amount = params.scrollAmount || 5;
      let scrolled = false;
      let backendUsed: string = info.mouseBackend;

      // Try xdotool (Button 4 = Up, Button 5 = Down, Button 6 = Left, Button 7 = Right)
      if (info.available.xdotool) {
        const btnMap: Record<string, string> = { up: "4", down: "5", left: "6", right: "7" };
        const btn = btnMap[dir] || "5";
        try {
          for (let i = 0; i < amount; i++) {
            execInputCmdSafe("xdotool", ["click", btn]);
          }
          scrolled = true;
          backendUsed = "xdotool";
        } catch {}
      }

      // Try ydotool
      if (info.available.ydotool && !scrolled) {
        try {
          const yAmount = dir === "up" ? -amount : dir === "down" ? amount : amount;
          execInputCmdSafe("ydotool", ["mousemove", "--wheel", String(yAmount)]);
          scrolled = true;
          backendUsed = "ydotool";
        } catch {}
      }

      if (scrolled) {
        return {
          success: true,
          action: "scroll",
          backendUsed,
          geometry: geometryStr,
          targetWindow: matchedWindow || undefined,
        };
      }
      throw new Error(`Failed to execute mouse scroll (${dir}, ${amount} steps).`);
    }

    // ── 3. Drag Action ──────────────────────────────────────────────────────
    if (params.action === "drag") {
      if (info.mouseBackend === "none") {
        throw new Error("No mouse input backend available for dragging.");
      }

      const startX = params.startX ?? params.x ?? 0;
      const startY = params.startY ?? params.y ?? 0;
      const endX = params.endX ?? params.x ?? 0;
      const endY = params.endY ?? params.y ?? 0;
      let dragged = false;
      let backendUsed: string = info.mouseBackend;

      if (info.available.xdotool) {
        try {
          execInputCmdSafe("xdotool", ["mousemove", String(startX), String(startY)]);
          execInputCmdSafe("xdotool", ["mousedown", "1"]);
          sleepSync(50);
          execInputCmdSafe("xdotool", ["mousemove", String(endX), String(endY)]);
          sleepSync(50);
          execInputCmdSafe("xdotool", ["mouseup", "1"]);
          dragged = true;
          backendUsed = "xdotool";
        } catch {}
      }

      if (dragged) {
        return {
          success: true,
          action: "drag",
          backendUsed,
          target: { x: endX, y: endY },
          geometry: geometryStr,
        };
      }
      throw new Error(`Failed to perform mouse drag from (${startX}, ${startY}) to (${endX}, ${endY}).`);
    }

    // ── 4. Move, Click, and Double Click Actions ────────────────────────────
    if (params.action === "move" || params.action === "click" || params.action === "double_click") {
      if (info.mouseBackend === "none") {
        throw new Error(
          "No mouse input backend available on system. Please install 'xdotool', 'ydotool', or 'dotool'."
        );
      }

      let targetX = params.x ?? 0;
      let targetY = params.y ?? 0;
      let relTarget: Coordinate | undefined;
      let backendUsed: string = info.mouseBackend;
      let warning: string | undefined;

      // Handle Window-Relative Coordinates calculation
      const isRelative = params.relativeToWindow ?? !!matchedWindow;
      if (matchedWindow && isRelative && params.x !== undefined && params.y !== undefined) {
        relTarget = { x: params.x, y: params.y };
        targetX = matchedWindow.x + params.x;
        targetY = matchedWindow.y + params.y;

        // Window bounds check
        if (
          params.x < 0 ||
          params.y < 0 ||
          params.x > matchedWindow.width ||
          params.y > matchedWindow.height
        ) {
          warning = `Window-relative target (${params.x}, ${params.y}) is out of target window bounds [0..${matchedWindow.width}, 0..${matchedWindow.height}].`;
        }
      }

      // Edge case: Out-of-bounds check against screen resolution
      let outOfBounds = false;
      if (
        targetX < 0 ||
        targetY < 0 ||
        targetX > info.geometry.width ||
        targetY > info.geometry.height
      ) {
        outOfBounds = true;
        const screenWarn = `Target screen coordinates (${targetX}, ${targetY}) exceed physical monitor dimensions [0..${info.geometry.width}, 0..${info.geometry.height}].`;
        warning = warning ? `${warning} | ${screenWarn}` : screenWarn;
      }

      // Execute movement if x and y specified
      if (params.x !== undefined && params.y !== undefined) {
        let moved = false;

        // Native window movement with xdotool if matchedWindow & xdotool available
        if (matchedWindow && info.available.xdotool && isRelative) {
          try {
            execInputCmdSafe("xdotool", ["mousemove", "--window", matchedWindow.windowId, String(params.x), String(params.y)]);
            moved = true;
            backendUsed = "xdotool (window-native)";
          } catch {}
        }

        // Fallback: ydotool absolute movement
        if (info.available.ydotool && !moved) {
          try {
            execInputCmdSafe("ydotool", ["mousemove", "--absolute", "-x", String(targetX), "-y", String(targetY)]);
            moved = true;
            backendUsed = "ydotool";
          } catch {}
        }

        // Fallback: xdotool absolute movement
        if (info.available.xdotool && !moved) {
          try {
            execInputCmdSafe("xdotool", ["mousemove", String(targetX), String(targetY)]);
            moved = true;
            backendUsed = "xdotool";
          } catch {}
        }

        // Fallback: dotool
        if (info.available.dotool && !moved) {
          try {
            execInputCmdSafe("sh", ["-c", `echo "mousemove ${targetX} ${targetY}" | dotool`]);
            moved = true;
            backendUsed = "dotool";
          } catch {}
        }

        if (!moved) {
          throw new Error(`Failed to move mouse cursor to target (${targetX}, ${targetY}).`);
        }
      }

      // Execute click if action === "click" or "double_click"
      if (params.action === "click" || params.action === "double_click") {
        let clicked = false;
        const clicksToPerform = params.action === "double_click" ? 2 : (params.clickCount || 1);

        // Try ydotool
        if (info.available.ydotool && !clicked) {
          const btnCode = button === "right" ? "0xC1" : button === "middle" ? "0xC2" : "0xC0";
          try {
            for (let c = 0; c < clicksToPerform; c++) {
              execInputCmdSafe("ydotool", ["click", btnCode]);
              if (c < clicksToPerform - 1) sleepSync(40);
            }
            clicked = true;
            backendUsed = "ydotool";
          } catch {}
        }

        // Try xdotool
        if (info.available.xdotool && !clicked) {
          const xbtnCode = button === "right" ? "3" : button === "middle" ? "2" : "1";
          try {
            if (matchedWindow && isRelative) {
              execInputCmdSafe("xdotool", ["click", "--window", matchedWindow.windowId, "--repeat", String(clicksToPerform), xbtnCode]);
            } else {
              execInputCmdSafe("xdotool", ["click", "--repeat", String(clicksToPerform), xbtnCode]);
            }
            clicked = true;
            backendUsed = "xdotool";
          } catch {}
        }

        // Try dotool
        if (info.available.dotool && !clicked) {
          const dbtn = button === "right" ? "btn_right" : button === "middle" ? "btn_middle" : "btn_left";
          try {
            for (let c = 0; c < clicksToPerform; c++) {
              execInputCmdSafe("sh", ["-c", `echo "click ${dbtn}" | dotool`]);
              if (c < clicksToPerform - 1) sleepSync(40);
            }
            clicked = true;
            backendUsed = "dotool";
          } catch {}
        }

        if (!clicked) {
          throw new Error(`Failed to perform ${button} click.`);
        }
      }

      // ── Post-Execution Location Verification & Auto Micro-Correction ───────
      let postPos = getCurrentMousePosition();

      // Micro-Correction Retry: If verification failed by 1..10 pixels due to acceleration/scaling, micro-correct!
      if (params.x !== undefined && params.y !== undefined && postPos.x !== undefined && postPos.y !== undefined) {
        const initialDx = Math.abs(postPos.x - targetX);
        const initialDy = Math.abs(postPos.y - targetY);

        if ((initialDx > 5 || initialDy > 5) && (initialDx <= 25 && initialDy <= 25)) {
          // Perform 1 quick micro-adjustment move directly to targetX, targetY
          if (info.available.xdotool) {
            try {
              execInputCmdSafe("xdotool", ["mousemove", String(targetX), String(targetY)]);
              postPos = getCurrentMousePosition();
            } catch {}
          } else if (info.available.ydotool) {
            try {
              execInputCmdSafe("ydotool", ["mousemove", "--absolute", "-x", String(targetX), "-y", String(targetY)]);
              postPos = getCurrentMousePosition();
            } catch {}
          }
        }
      }

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
        targetWindowRelative: relTarget,
        actual,
        delta,
        outOfBounds: outOfBounds ? true : undefined,
        targetWindow: matchedWindow || undefined,
        currentWindowId: postPos.windowId || matchedWindow?.windowId,
        currentWindowTitle: matchedWindow?.windowTitle,
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
    "Control mouse cursor (move/click/double_click/scroll/drag/position). Defaults to entire physical screen coordinates (x, y). Optionally pass application window parameters (windowTitle, windowClass, windowId) to target & auto-focus a specific app window and use window-relative coordinates. Features safe array process execution, post-execution location verification, micro-correction retry, and multi-monitor support.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["move", "click", "double_click", "scroll", "drag", "position"],
        description: "Mouse action to perform",
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button (for click/double_click, default: left)",
      },
      clickCount: {
        type: "number",
        description: "Number of consecutive clicks to perform (default: 1, 2 for double click)",
      },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
        description: "Scroll direction (for action=scroll, default: down)",
      },
      scrollAmount: {
        type: "number",
        description: "Number of scroll steps/clicks (default: 5)",
      },
      x: {
        type: "number",
        description: "Target X coordinate (screen absolute OR window relative if window specified)",
      },
      y: {
        type: "number",
        description: "Target Y coordinate (screen absolute OR window relative if window specified)",
      },
      startX: {
        type: "number",
        description: "Start X coordinate for drag action",
      },
      startY: {
        type: "number",
        description: "Start Y coordinate for drag action",
      },
      endX: {
        type: "number",
        description: "End X coordinate for drag action",
      },
      endY: {
        type: "number",
        description: "End Y coordinate for drag action",
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
      relativeToWindow: {
        type: "boolean",
        description: "If true, treat (x, y) as relative to top-left corner of the target window (default: true if window specified)",
      },
      focusWindow: {
        type: "boolean",
        description: "If true, automatically focus/bring target window to front before action (default: true)",
      },
      duration: {
        type: "number",
        description: "Movement duration in ms (default: 100)",
      },
      steps: {
        type: "number",
        description: "Number of steps for movement (default: 5)",
      },
    },
    required: ["action"],
  },
};
