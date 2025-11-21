import { spawn, ChildProcess } from "child_process";
import { writeFile, unlink, chmod } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getDialogBackend } from "../utils/de-detect.js";

export type SudoMethod = "askpass" | "pkexec";

export interface SudoExecuteParams {
  command: string;
  method?: SudoMethod;
  run_as_user?: string;        // Run as specific user (for yay/paru/makepkg)
  login_shell?: boolean;       // Use login shell (-i) to load user's full environment
  preserve_env?: boolean;      // Preserve current environment variables (-E)
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
  run_as: string;              // Which user the command ran as
}

async function createAskpassScript(): Promise<string> {
  const detection = getDialogBackend();
  const scriptPath = join(tmpdir(), `mcp-askpass-${Date.now()}.sh`);

  let dialogCommand: string;

  if (detection.backend === "kdialog") {
    dialogCommand = `kdialog --password "sudo password required"`;
  } else if (detection.backend === "zenity") {
    dialogCommand = `zenity --password --title="Sudo Authentication" --text="Password required"`;
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

function buildSudoArgs(params: {
  command: string;
  runAsUser?: string;
  loginShell?: boolean;
  preserveEnv?: boolean;
  useAskpass?: boolean;
}): string[] {
  const args: string[] = [];

  // Use askpass for GUI password prompt
  if (params.useAskpass) {
    args.push("-A");
  }

  // Preserve environment variables
  if (params.preserveEnv) {
    args.push("-E");
  }

  // Run as specific user
  if (params.runAsUser) {
    args.push("-u", params.runAsUser);
  }

  // Use login shell for full user environment
  if (params.loginShell) {
    args.push("-i");
  }

  // Add the command
  args.push("bash", "-c", params.command);

  return args;
}

function buildEnvForUser(runAsUser?: string): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    DISPLAY: process.env.DISPLAY || ":0",
  };

  // If running as specific user, set their HOME and XDG dirs
  if (runAsUser) {
    env.HOME = `/home/${runAsUser}`;
    env.USER = runAsUser;
    env.LOGNAME = runAsUser;
    // XDG_RUNTIME_DIR is user-specific
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.() || 1000}`;
  }

  return env;
}

async function runWithAskpass(
  command: string,
  workingDir: string,
  timeoutMs: number,
  runAsUser?: string,
  loginShell?: boolean,
  preserveEnv?: boolean
): Promise<SudoExecuteResult> {
  let askpassScript: string | null = null;

  try {
    askpassScript = await createAskpassScript();

    return await new Promise<SudoExecuteResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let resolved = false;

      const sudoArgs = buildSudoArgs({
        command,
        runAsUser,
        loginShell,
        preserveEnv,
        useAskpass: true,
      });

      const env = buildEnvForUser(runAsUser);
      env.SUDO_ASKPASS = askpassScript!;

      const proc: ChildProcess = spawn("sudo", sudoArgs, {
        cwd: workingDir,
        env,
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
          const cancelled = code === 1 && (
            stderr.includes("no askpass program") ||
            stderr.includes("a]ssword") // partial match for cancelled dialog
          );

          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exit_code: code ?? 1,
            timed_out: timedOut,
            cancelled: cancelled || (code === 1 && stdout === "" && stderr === "" && !timedOut),
            method_used: "askpass",
            run_as: runAsUser || "root",
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
            run_as: runAsUser || "root",
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
  timeoutMs: number,
  runAsUser?: string
): Promise<SudoExecuteResult> {
  return new Promise<SudoExecuteResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    // pkexec doesn't support -u directly, so we need to chain with sudo for user switch
    let finalCommand = command;
    let pkexecArgs: string[];

    if (runAsUser) {
      // pkexec to root, then sudo -u user to run as specific user
      finalCommand = `sudo -u ${runAsUser} bash -c '${command.replace(/'/g, "'\\''")}'`;
      pkexecArgs = ["bash", "-c", finalCommand];
    } else {
      pkexecArgs = ["bash", "-c", command];
    }

    const env = buildEnvForUser(runAsUser);

    const proc: ChildProcess = spawn("pkexec", pkexecArgs, {
      cwd: workingDir,
      env,
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
          run_as: runAsUser || "root",
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
          run_as: runAsUser || "root",
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
    return runWithPkexec(params.command, workingDir, timeoutMs, params.run_as_user);
  } else {
    return runWithAskpass(
      params.command,
      workingDir,
      timeoutMs,
      params.run_as_user,
      params.login_shell,
      params.preserve_env
    );
  }
}

export const sudoExecuteToolDefinition = {
  name: "sudo_execute",
  description:
    "Execute a command with elevated privileges or as a specific user. Shows a GUI password dialog. Use for: (1) root operations like package installation, service management, (2) running commands as specific user (e.g., yay/paru which refuse to run as root).",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      method: {
        type: "string",
        enum: ["askpass", "pkexec"],
        description:
          "Authentication method: 'askpass' uses kdialog/zenity (default), 'pkexec' uses PolicyKit",
      },
      run_as_user: {
        type: "string",
        description:
          "Run command as this user instead of root. Essential for commands like yay/paru/makepkg that refuse to run as root.",
      },
      login_shell: {
        type: "boolean",
        description:
          "Use login shell (-i) to load the target user's full environment (.bashrc, .profile, etc.). Recommended when running as another user.",
      },
      preserve_env: {
        type: "boolean",
        description:
          "Preserve current environment variables (-E). Useful for GUI apps or commands needing DISPLAY, PATH, etc.",
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
