import { spawn } from "child_process";
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveSessionEnv } from "../utils/dialog-backend.js";
import { execSync } from "child_process";

export interface ScreenshotOptions {
  format?: "png" | "jpg";
  filename?: string;
  grid?: boolean;
  gridStep?: number;
  drawCursorLocation?: boolean;
  xAxisPosition?: "top" | "bottom" | "both" | "none";
  yAxisPosition?: "left" | "right" | "both" | "none";
  yAxisAngle?: number;
}

export interface ScreenshotResult {
  success: boolean;
  backend: string;
  format: string;
  data?: string;
  filename?: string;
  size?: number;
  gridApplied?: boolean;
  cursorLocationDrawn?: boolean;
  cursorPosition?: { x: number; y: number };
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number = 15000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 124 });
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
      }
    });

    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: "", stderr: "", exitCode: 1 });
      }
    });
  });
}

function checkCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const format = options.format ?? "png";
  const showGrid = options.grid ?? true;
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-screenshot-"));
  const tempFile = join(tempDir, `screenshot.${format}`);

  try {
    let usedBackend = "";
    let imageBuffer: Buffer | null = null;

    // 1. grim (Wayland-native — best on Wayland)
    if (!imageBuffer && checkCommand("grim")) {
      try {
        const result = await runCommand("grim", ["-t", format, tempFile], 15000);
        if (result.exitCode === 0) {
          imageBuffer = readFileSync(tempFile);
          usedBackend = "grim";
        }
      } catch {}
    }

    // 2. KDE spectacle (works at user level, X11 + Wayland via XWayland)
    if (!imageBuffer && checkCommand("spectacle")) {
      try {
        const result = await runCommand("spectacle", ["-b", "-p", "-o", tempFile], 15000);
        if (result.exitCode === 0) {
          imageBuffer = readFileSync(tempFile);
          usedBackend = "spectacle";
        }
      } catch {}
    }

    // 3. scrot (X11)
    if (!imageBuffer && checkCommand("scrot")) {
      try {
        const result = await runCommand("scrot", [tempFile], 15000);
        if (result.exitCode === 0) {
          imageBuffer = readFileSync(tempFile);
          usedBackend = "scrot";
        }
      } catch {}
    }

    // 4. import (ImageMagick X11)
    if (!imageBuffer && checkCommand("import")) {
      try {
        const result = await runCommand("import", ["-window", "root", tempFile], 15000);
        if (result.exitCode === 0) {
          imageBuffer = readFileSync(tempFile);
          usedBackend = "import";
        }
      } catch {}
    }

    // 5. gnome-screenshot
    if (!imageBuffer && checkCommand("gnome-screenshot")) {
      try {
        const result = await runCommand("gnome-screenshot", ["-f", tempFile], 15000);
        if (result.exitCode === 0) {
          imageBuffer = readFileSync(tempFile);
          usedBackend = "gnome-screenshot";
        }
      } catch {}
    }

    if (!imageBuffer) {
      throw new Error(
        "No screenshot backend available. Install one of: grim (Wayland), spectacle (KDE), scrot (X11), imagemagick, gnome-screenshot"
      );
    }

    let gridApplied = false;
    let cursorLocationDrawn = false;
    let mousePos: { x?: number; y?: number } = {};

    // 6. Post-processing: Overlay Grid lines and/or Cursor Location Crosshair using ImageMagick
    const imCmd = checkCommand("magick") ? "magick" : checkCommand("convert") ? "convert" : "";
    if ((showGrid || options.drawCursorLocation) && imCmd) {
      try {
        const drawCommands: string[] = [];
        const gridStep = Math.max(20, options.gridStep ?? 0);

        if (showGrid) {
          // Identify image dimensions via identify command or defaults (1920x1080)
          let imgW = 1920;
          let imgH = 1080;
          try {
            const dimOut = execSync(`identify -format "%w %h" "${tempFile}"`, { encoding: "utf8" }).trim();
            const [wStr, hStr] = dimOut.split(" ");
            if (wStr && hStr) {
              imgW = parseInt(wStr, 10);
              imgH = parseInt(hStr, 10);
            }
          } catch {}

          // Smart Auto GridStep: Automatically choose optimal grid spacing if not explicitly passed
          let gridStep = options.gridStep;
          if (!gridStep || gridStep <= 0) {
            // Adaptive scaling: for 1920 width -> 100px; for 3840 -> 200px; for smaller screens -> 50px
            gridStep = imgW >= 2560 ? 150 : imgW >= 1440 ? 100 : 50;
          }

          // Build SVG/ImageMagick command for Battleship / Ruler style non-intrusive grid
          const gridScript = [];

          // 1. Distinct Colors for X and Y Grid Lines & Numbers
          // X-Axis Grid Lines: Cyan (semi-transparent)
          for (let x = gridStep; x < imgW; x += gridStep) {
            gridScript.push(`stroke rgba(0,255,255,0.22) stroke-width 1 line ${x},0 ${x},${imgH}`);
          }
          // Y-Axis Grid Lines: Vibrant Magenta/Pink (semi-transparent)
          for (let y = gridStep; y < imgH; y += gridStep) {
            gridScript.push(`stroke rgba(255,0,225,0.22) stroke-width 1 line 0,${y} ${imgW},${y}`);
          }

          // Position settings with defaults (X default: top, Y default: right)
          const xPos = options.xAxisPosition ?? "top";
          const yPos = options.yAxisPosition ?? "right";
          const rotAngle = options.yAxisAngle ?? -45;

          // 2. High-Contrast Transparent X-Axis Numbers (Cyan Ticks, Black Outline + Yellow Text)
          const renderXTop = xPos === "top" || xPos === "both";
          const renderXBottom = xPos === "bottom" || xPos === "both";

          for (let x = gridStep; x < imgW; x += gridStep) {
            const numStr = String(x);
            if (renderXTop) {
              gridScript.push(`stroke cyan stroke-width 2 line ${x},0 ${x},18`);
              gridScript.push(`stroke black stroke-width 3 font-size 26 font-weight bold text ${x - 20},32 '${numStr}'`);
              gridScript.push(`fill yellow stroke none font-size 26 font-weight bold text ${x - 20},32 '${numStr}'`);
            }
            if (renderXBottom) {
              gridScript.push(`stroke cyan stroke-width 2 line ${x},${imgH - 18} ${x},${imgH}`);
              gridScript.push(`stroke black stroke-width 3 font-size 26 font-weight bold text ${x - 20},${imgH - 12} '${numStr}'`);
              gridScript.push(`fill yellow stroke none font-size 26 font-weight bold text ${x - 20},${imgH - 12} '${numStr}'`);
            }
          }

          // 3. High-Contrast Transparent Y-Axis Numbers (Magenta Ticks, Black Outline + Bright Lime/Green Text)
          const renderYLeft = yPos === "left" || yPos === "both";
          const renderYRight = yPos === "right" || yPos === "both";

          for (let y = gridStep; y < imgH; y += gridStep) {
            const numStr = String(y);

            if (renderYLeft) {
              gridScript.push(`stroke #ff00e1 stroke-width 2 line 0,${y} 18,${y}`);
              // Use translate + rotate for rock-solid coordinate transformation on Left border
              gridScript.push(`push graphic-context translate 10,${y} rotate ${rotAngle} stroke black stroke-width 3 font-size 24 font-weight bold text -15,-5 '${numStr}' pop graphic-context`);
              gridScript.push(`push graphic-context translate 10,${y} rotate ${rotAngle} fill #00ff66 stroke none font-size 24 font-weight bold text -15,-5 '${numStr}' pop graphic-context`);
            }

            if (renderYRight) {
              gridScript.push(`stroke #ff00e1 stroke-width 2 line ${imgW - 18},${y} ${imgW},${y}`);
              // Use translate + rotate for rock-solid coordinate transformation on Right border (always visible on screen!)
              gridScript.push(`push graphic-context translate ${imgW - 65},${y} rotate ${rotAngle} stroke black stroke-width 3 font-size 24 font-weight bold text 0,0 '${numStr}' pop graphic-context`);
              gridScript.push(`push graphic-context translate ${imgW - 65},${y} rotate ${rotAngle} fill #00ff66 stroke none font-size 24 font-weight bold text 0,0 '${numStr}' pop graphic-context`);
            }
          }

          const drawArg = gridScript.join(" ");
          execSync(`${imCmd} "${tempFile}" -draw "${drawArg}" "${tempFile}"`);
          gridApplied = true;
        }

        if (options.drawCursorLocation) {
          try {
            const { getCurrentMousePosition } = await import("../utils/input-detect.js");
            mousePos = getCurrentMousePosition();
            if (mousePos.x !== undefined && mousePos.y !== undefined) {
              const mx = mousePos.x;
              const my = mousePos.y;
              const coordStr = `(${mx}, ${my})`;
              const labelWidth = coordStr.length * 8 + 12;

              const crossScript = [
                // Minimal target ring
                `stroke red stroke-width 2 fill none circle ${mx},${my} ${mx + 14},${my}`,
                // Crosshair lines
                `stroke black stroke-width 3 line ${mx - 20},${my} ${mx + 20},${my}`,
                `stroke black stroke-width 3 line ${mx},${my - 20} ${mx},${my + 20}`,
                `stroke yellow stroke-width 1.5 line ${mx - 20},${my} ${mx + 20},${my}`,
                `stroke yellow stroke-width 1.5 line ${mx},${my - 20} ${mx},${my + 20}`,
                // Non-intrusive floating badge
                `fill rgba(0,0,0,0.9) stroke yellow stroke-width 1 roundrectangle ${mx + 10},${my + 10} ${mx + 10 + labelWidth},${my + 28} 3,3`,
                `fill yellow stroke none font-size 11 font-weight bold text ${mx + 15},${my + 23} '${coordStr}'`
              ].join(" ");

              execSync(`${imCmd} "${tempFile}" -draw "${crossScript}" "${tempFile}"`);
              cursorLocationDrawn = true;
            }
          } catch (e) {
            console.error("Crosshair error:", e);
          }
        }

        imageBuffer = readFileSync(tempFile);
      } catch (err) {
        console.error("Post processing error:", err);
      }
    }

    const size = imageBuffer.length;
    let data: string | undefined;
    let filename: string | undefined;

    if (options.filename) {
      copyFileSync(tempFile, options.filename);
      filename = options.filename;
    } else {
      data = imageBuffer.toString("base64");
    }

    return {
      success: true,
      backend: usedBackend,
      format,
      data,
      filename,
      size,
      gridApplied: gridApplied || undefined,
      cursorLocationDrawn: cursorLocationDrawn || undefined,
      cursorPosition: mousePos.x !== undefined && mousePos.y !== undefined ? { x: mousePos.x, y: mousePos.y } : undefined,
    };

  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

export const screenshotToolDefinition = {
  name: "screenshot",
  description:
    "Take a screenshot of the full desktop. Returns base64-encoded PNG/JPG by default, " +
    "or saves to a file if 'filename' is provided. " +
    "Supports optional visual pixel grid overlay (grid=true, gridStep=100) and mouse location target crosshair overlay (drawCursorLocation=true) for precise UI element coordinate identification. " +
    "Fallback chain: grim (Wayland) → spectacle (KDE) → scrot (X11) → import (ImageMagick) → gnome-screenshot.",
  inputSchema: {
    type: "object" as const,
    properties: {
      format: {
        type: "string",
        enum: ["png", "jpg"],
        description: "Image format (default: png)",
      },
      filename: {
        type: "string",
        description: "Absolute path to save screenshot to file instead of returning base64",
      },
      grid: {
        type: "boolean",
        description: "If true (default: true), overlay Battleship ruler pixel coordinate grid and numbers. Set false to disable.",
      },
      gridStep: {
        type: "number",
        description: "Pixel interval step size for grid lines and labels (default: 100, e.g. 50 or 100)",
      },
      drawCursorLocation: {
        type: "boolean",
        description: "If true, draw a high-contrast target crosshair (+) and coordinate tag at the current mouse position (default: false)",
      },
      xAxisPosition: {
        type: "string",
        enum: ["top", "bottom", "both", "none"],
        description: "Placement position for horizontal X-axis ruler numbers (default: 'top')",
      },
      yAxisPosition: {
        type: "string",
        enum: ["left", "right", "both", "none"],
        description: "Placement position for vertical Y-axis ruler numbers (default: 'right')",
      },
      yAxisAngle: {
        type: "number",
        description: "Rotation angle in degrees for vertical Y-axis ruler numbers (default: -45)",
      },
    },
  },
};
