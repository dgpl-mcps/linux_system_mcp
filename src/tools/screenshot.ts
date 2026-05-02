import { spawn } from "child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
  const format = options.format ?? "png";
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-screenshot-"));
  const tempFile = join(tempDir, `screenshot.${format}`);

  try {
    // Use spectacle (KDE screenshot tool) which works
    const result = await runCommand("spectacle", ["-b", "-o", tempFile], 15000);
    
    if (result.exitCode !== 0) {
      throw new Error(`Screenshot failed: ${result.stderr || "unknown error"}`);
    }

    const imageBuffer = readFileSync(tempFile);
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
      backend: "spectacle",
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
    "Supports: png, jpg formats. Uses KDE spectacle on KDE, or scrot/import on other systems.",
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