import { spawn } from "child_process";
import { homedir } from "os";

export interface ShellExecuteParams {
  command: string;
  working_dir?: string;
  timeout?: number; // in seconds
  shell?: string;
}

export interface ShellExecuteResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  working_dir: string;
}

export async function shellExecute(
  params: ShellExecuteParams
): Promise<ShellExecuteResult> {
  const workingDir = params.working_dir || homedir();
  const timeoutMs = (params.timeout ?? 30) * 1000;
  const shell = params.shell || "/bin/bash";

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(shell, ["-c", params.command], {
      cwd: workingDir,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 1000);
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code ?? (timedOut ? 124 : 1),
        timed_out: timedOut,
        working_dir: workingDir,
      });
    });

    proc.on("error", (error) => {
      clearTimeout(timeoutHandle);
      resolve({
        stdout: "",
        stderr: error.message,
        exit_code: 1,
        timed_out: false,
        working_dir: workingDir,
      });
    });
  });
}

export const shellExecuteToolDefinition = {
  name: "shell_execute",
  description:
    "Execute a shell command and return the output. Use this for all system queries, including filesystem usage (`df`), partition info (`lsblk`), memory usage (`free`), CPU monitoring (`top`), package management, git operations, or any other command-line task. This runs non-interactive commands only. Chain with ask_input to get arguments from the user first, or ask_confirmation before running potentially destructive commands.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description:
          "The shell command to execute. Can include pipes, redirects, and multiple commands separated by && or ;",
      },
      working_dir: {
        type: "string",
        description: "Working directory for the command (default: user home directory)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 30, max: 300)",
      },
      shell: {
        type: "string",
        description: "Shell to use (default: /bin/bash)",
      },
    },
    required: ["command"],
  },
};
