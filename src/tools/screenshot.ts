import { spawn, execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getInputBackend } from "../utils/input-detect.js";
import { resolveSessionEnv } from "../utils/dialog-backend.js";

export interface ScreenshotOptions {
  format?: "png" | "jpg";
  filename?: string;  // If provided, save to file and return path; otherwise return base64
  x?: number;        // X coordinate for region capture
  y?: number;        // Y coordinate for region capture
  width?: number;    // Width for region capture
  height?: number;  // Height for region capture
}

export interface ScreenshotResult {
  success: boolean;
  backend: string;
  format: string;
  data?: string;      // Base64 encoded image (if not saved to file)
  filename?: string;  // Path to saved file (if saved to file)
  size?: number;      // Size in bytes
}

// Get the input backend result (cached)
function getBackend() {
  return getInputBackend();
}

// Run command with session environment
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

/**
 * Take a screenshot using available backends
 * Falls back through: screenshot-desktop → scrot → import → grim → error
 */
export async function screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const backend = getBackend();
  const format = options.format ?? "png";
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-screenshot-"));
  const tempFile = join(tempDir, `screenshot.${format}`);

  try {
    let result: { stdout: string; stderr: string; exitCode: number };
    let usedBackend = "";

    // Try native screenshot tools based on display server
    if (backend.displayServer === "wayland" && backend.available.grim) {
      // Wayland: use grim
      result = await runCommand("grim", ["-t", format, tempFile], 15000);
      usedBackend = "grim";
    } else if (backend.displayServer === "x11" && backend.available.scrot) {
      // X11: use scrot
      result = await runCommand("scrot", [tempFile], 15000);
      usedBackend = "scrot";
    } else if (backend.available.import) {
      // ImageMagick import (works on both X11 and XWayland)
      // Note: import requires the output file as the LAST argument
      const args = ["-window", "root", tempFile];
      result = await runCommand("import", args, 15000);
      usedBackend = "import";
    } else if (backend.available.grim) {
      // Fallback to grim on X11 (works with XWayland)
      result = await runCommand("grim", ["-t", format, "-o", tempFile], 15000);
      usedBackend = "grim";
    } else {
      throw new Error("No screenshot tool available (tried: grim, scrot, import)");
    }

    if (result.exitCode !== 0) {
      throw new Error(`Screenshot failed: ${result.stderr || "unknown error"}`);
    }

    // Read the screenshot file
    const fs = require("fs");
    const imageBuffer = fs.readFileSync(tempFile);
    const size = imageBuffer.length;
    
    let data: string | undefined;
    let filename: string | undefined;

    if (options.filename) {
      // Save to specified file
      fs.copyFileSync(tempFile, options.filename);
      filename = options.filename;
    } else {
      // Return as base64
      data = imageBuffer.toString("base64");
    }

    return {
      success: true,
      backend: usedBackend,
      format,
      data,
      filename,
      size,
    };

  } finally {
    // Clean up temp file
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// ============ TOOL DEFINITIONS ============

export const screenshotToolDefinition = {
  name: "screenshot",
  description: "Take a screenshot of the entire screen. " +
    "Returns base64 image by default. " +
    "Parameters: format (png/jpg, default png), filename (optional - save to file instead of returning base64), " +
    "x, y, width, height (optional - for region capture).",
  inputSchema: {
    type: "object",
    properties: {
      format: { 
        type: "string", 
        enum: ["png", "jpg"],
        description: "Image format (default: png)" 
      },
      filename: { 
        type: "string", 
        description: "If provided, save to this file path instead of returning base64" 
      },
      x: { type: "number", description: "X coordinate for region capture" },
      y: { type: "number", description: "Y coordinate for region capture" },
      width: { type: "number", description: "Width for region capture" },
      height: { type: "number", description: "Height for region capture" },
    },
  },
};