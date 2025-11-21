import { spawn, ChildProcess } from "child_process";
import { writeFile, unlink, chmod } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getDialogBackend } from "../utils/de-detect.js";

export type SudoMethod = "askpass" | "pkexec";

export interface SudoExecuteParams {
  command: string;
  method?: SudoMethod;
  working_dir?: string;
  timeout?: number;
}

export interface SudoExecuteResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  cancelled: boolean;
  method_used: SudoMethod;
}

async function createAskpassScript(): Promise<string> {
  const detection = getDialogBackend();
  const scriptPath = join(tmpdir(), `mcp-askpass-${Date.now()}.sh`);

  let dialogCommand: string;

  if (detection.backend === "kdialog") {
    dialogCommand = `kdialog --password "sudo password required for: $SUDO_COMMAND"`;
  } else if (detection.backend === "zenity") {
    dialogCommand = `zenity --password --title="Sudo Authentication" --text="Password required for: $SUDO_COMMAND"`;
  } else {
    throw new Error("No dialog backend available for password prompt. Install kdialog or zenity.");
  }

  const scriptContent = `#!/bin/bash
${dialogCommand}
`;

  await writeFile(scriptPath, scriptContent, { mode: 0o700 });
  await chmod(scriptPath, 0o700);

  return scriptPath;
}

async function runWithAskpass(
  command: string,
  workingDir: string,
  timeoutMs: number
): Promise<SudoExecuteResult> {
  let askpassScript: string | null = null;

  try {
    askpassScript = await createAskpassScript();

    return await new Promise<SudoExecuteResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let resolved = false;

      const proc: ChildProcess = spawn("sudo", ["-A", "bash", "-c", command], {
        cwd: workingDir,
        env: {
          ...process.env,
          SUDO_ASKPASS: askpassScript!,
          DISPLAY: process.env.DISPLAY || ":0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          proc.kill("SIGTERM");
        }
      }, timeoutMs);

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code: number | null) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);

          // Check if user cancelled the password dialog
          const cancelled = code === 1 && stderr.includes("no askpass program");

          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exit_code: code ?? 1,
            timed_out: timedOut,
            cancelled: cancelled || (code === 1 && stdout === "" && !timedOut),
            method_used: "askpass",
          });
        }
      });

      proc.on("error", (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            stdout: "",
            stderr: err.message,
            exit_code: 1,
            timed_out: false,
            cancelled: false,
            method_used: "askpass",
          });
        }
      });
    });
  } finally {
    // Clean up askpass script
    if (askpassScript) {
      try {
        await unlink(askpassScript);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

async function runWithPkexec(
  command: string,
  workingDir: string,
  timeoutMs: number
): Promise<SudoExecuteResult> {
  return new Promise<SudoExecuteResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    // pkexec runs command directly, wrap in bash for complex commands
    const proc: ChildProcess = spawn("pkexec", ["bash", "-c", command], {
      cwd: workingDir,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        timedOut = true;
        proc.kill("SIGTERM");
      }
    }, timeoutMs);

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);

        // pkexec exit code 126 = user dismissed dialog
        const cancelled = code === 126;

        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exit_code: code ?? 1,
          timed_out: timedOut,
          cancelled,
          method_used: "pkexec",
        });
      }
    });

    proc.on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          stdout: "",
          stderr: err.message,
          exit_code: 1,
          timed_out: false,
          cancelled: false,
          method_used: "pkexec",
        });
      }
    });
  });
}

export async function sudoExecute(params: SudoExecuteParams): Promise<SudoExecuteResult> {
  const method = params.method || "askpass";
  const workingDir = params.working_dir || process.env.HOME || "/";
  const timeoutMs = (params.timeout ?? 120) * 1000; // Default 2 minutes for sudo operations

  if (method === "pkexec") {
    return runWithPkexec(params.command, workingDir, timeoutMs);
  } else {
    return runWithAskpass(params.command, workingDir, timeoutMs);
  }
}

export const sudoExecuteToolDefinition = {
  name: "sudo_execute",
  description:
    "Execute a command with sudo privileges. Shows a GUI password dialog to the user. Use this for operations requiring root access like package installation, system configuration, or service management.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The command to execute with sudo privileges",
      },
      method: {
        type: "string",
        enum: ["askpass", "pkexec"],
        description:
          "Method for authentication: 'askpass' uses kdialog/zenity password dialog (default), 'pkexec' uses PolicyKit native dialog",
      },
      working_dir: {
        type: "string",
        description: "Working directory for the command (default: user home)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 120)",
      },
    },
    required: ["command"],
  },
};
