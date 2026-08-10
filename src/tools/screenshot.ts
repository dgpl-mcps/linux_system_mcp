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
    if ((options.grid || options.drawCursorLocation) && imCmd) {
      try {
        const drawCommands: string[] = [];
        const gridStep = Math.max(20, options.gridStep ?? 100);

        if (options.grid) {
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

          // Build SVG/ImageMagick command for grid
          const gridScript = [];
          // Vertical lines + numbers
          for (let x = gridStep; x < imgW; x += gridStep) {
            gridScript.push(`stroke cyan stroke-width 1 line ${x},0 ${x},${imgH}`);
            gridScript.push(`fill cyan stroke none font-size 11 text ${x + 2},14 '${x}'`);
          }
          // Horizontal lines + numbers
          for (let y = gridStep; y < imgH; y += gridStep) {
            gridScript.push(`stroke cyan stroke-width 1 line 0,${y} ${imgW},${y}`);
            gridScript.push(`fill cyan stroke none font-size 11 text 4,${y - 2} '${y}'`);
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
              const crossScript = [
                // Outer circle
                `stroke red stroke-width 2 fill none circle ${mx},${my} ${mx + 18},${my}`,
                // Crosshair lines
                `stroke yellow stroke-width 2 line ${mx - 25},${my} ${mx + 25},${my}`,
                `stroke yellow stroke-width 2 line ${mx},${my - 25} ${mx},${my + 25}`,
                // Text label box
                `fill black stroke red stroke-width 1 rectangle ${mx + 10},${my + 10} ${mx + 110},${my + 30}`,
                `fill yellow stroke none font-size 12 text ${mx + 15},${my + 25} '(${mx}, ${my})'`
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
        description: "If true, overlay a semi-transparent pixel coordinate grid and numbers (default: false)",
      },
      gridStep: {
        type: "number",
        description: "Pixel interval step size for grid lines and labels (default: 100, e.g. 50 or 100)",
      },
      drawCursorLocation: {
        type: "boolean",
        description: "If true, draw a high-contrast target crosshair (+) and coordinate tag at the current mouse position (default: false)",
      },
    },
  },
};
