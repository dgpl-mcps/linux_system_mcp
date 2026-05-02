import { spawn, execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getInputBackend } from "../utils/input-detect.js";
import { resolveSessionEnv } from "../utils/dialog-backend.js";

export interface ScreenshotOptions {
  format?: "png" | "jpg";
  filename?: string;
}

export interface ScreenshotResult {
  success: boolean;
  backend: string;
  format: string;
  data?: string;
  filename?: string;
  size?: number;
}

function getBackend() {
  return getInputBackend();
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

export async function screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const backend = getBackend();
  const format = options.format ?? "png";
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-screenshot-"));
  const tempFile = join(tempDir, `screenshot.${format}`);

  try {
    let result: { stdout: string; stderr: string; exitCode: number } | null = null;
    let usedBackend = "";

    // Priority order: grim (Wayland) > scrot (X11) > import > xwd
    const backends = [
      { name: "grim", check: () => backend.available.grim, args: ["-t", format, tempFile] },
      { name: "scrot", check: () => backend.available.scrot, args: [tempFile] },
      { name: "import", check: () => backend.available.import, args: ["-window", "root", tempFile] },
    ];

    for (const b of backends) {
      if (b.check()) {
        try {
          result = await runCommand(b.name, b.args, 15000);
          if (result.exitCode === 0) {
            usedBackend = b.name;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    // Try fallback tools if no backend worked
    if (!usedBackend) {
      const fallbackTools = ["gnome-screenshot", "kscreenshot", "spectacle"];
      for (const tool of fallbackTools) {
        try {
          const whichOut = execSync(`which ${tool}`, { stdio: "ignore" }).toString().trim();
          if (whichOut) {
            result = await runCommand(tool, ["-f", tempFile], 15000);
            if (result && result.exitCode === 0) {
              usedBackend = tool;
              break;
            }
          }
        } catch {
          continue;
        }
      }
    }

    if (!usedBackend || !result || result.exitCode !== 0) {
      throw new Error("No screenshot tool available. Install: scrot (X11), grim (Wayland), or import (ImageMagick)");
    }

    const fs = require("fs");
    const imageBuffer = fs.readFileSync(tempFile);
    const size = imageBuffer.length;
    
    let data: string | undefined;
    let filename: string | undefined;

    if (options.filename) {
      fs.copyFileSync(tempFile, options.filename);
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
    };

  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

export const screenshotToolDefinition = {
  name: "screenshot",
  description: "Take a screenshot. Returns base64 by default, or saves to file if filename provided. " +
    "Supports: png, jpg formats. Install: scrot (X11) or grim (Wayland).",
  inputSchema: {
    type: "object" as const,
    properties: {
      format: { 
        type: "string", 
        enum: ["png", "jpg"],
        description: "Image format (default: png)" 
      },
      filename: { 
        type: "string", 
        description: "Save to file instead of returning base64" 
      },
    },
  },
};