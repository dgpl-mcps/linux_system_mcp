import { spawn, ChildProcess } from "child_process";
import { writeFile, unlink, chmod } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getDialogBackend } from "../utils/de-detect.js";
import { getDialogManager } from "../utils/dialog-backend.js";

export type SudoMethod = "askpass" | "pkexec";

export interface SudoExecuteParams {
  command: string;
  method?: SudoMethod;
  run_as_user?: string;        // Run as specific user (for yay/paru/makepkg)
  login_shell?: boolean;       // Use login shell (-i) to load user's full environment
  preserve_env?: boolean;      // Preserve current environment variables (-E)
  nested_askpass?: boolean;    // Enable askpass for nested sudo calls (for paru/yay)
  notify_on_error?: boolean;   // Send desktop notification on error (default: true)
  working_dir?: string;
  timeout?: number;
}

export interface ErrorSummary {
  type: "auth_failed" | "not_in_sudoers" | "command_not_found" | "permission_denied" | "timeout" | "cancelled" | "unknown";
  message: string;
  context: string[];  // Lines around the error
  suggestion?: string;
}

export interface SudoExecuteResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  cancelled: boolean;
  method_used: SudoMethod;
  run_as: string;
  error_summary?: ErrorSummary;
}

// Error patterns to detect
const ERROR_PATTERNS: { pattern: RegExp; type: ErrorSummary["type"]; suggestion: string }[] = [
  { pattern: /not in the sudoers file/i, type: "not_in_sudoers", suggestion: "Add user to sudoers: sudo usermod -aG wheel <user>" },
  { pattern: /incorrect password attempts/i, type: "auth_failed", suggestion: "Wrong password entered. Try again." },
  { pattern: /no password was provided/i, type: "auth_failed", suggestion: "Password dialog was cancelled or failed." },
  { pattern: /command not found/i, type: "command_not_found", suggestion: "Install the required command first." },
  { pattern: /permission denied/i, type: "permission_denied", suggestion: "Insufficient permissions for this operation." },
  { pattern: /operation cancelled/i, type: "cancelled", suggestion: "User cancelled the operation." },
];

function parseError(stdout: string, stderr: string, timedOut: boolean, cancelled: boolean): ErrorSummary | undefined {
  const combined = `${stdout}\n${stderr}`;

  if (timedOut) {
    return {
      type: "timeout",
      message: "Operation timed out",
      context: stderr.split("\n").slice(-5),
      suggestion: "Increase timeout or check if command is stuck.",
    };
  }

  if (cancelled) {
    return {
      type: "cancelled",
      message: "Operation was cancelled",
      context: [],
      suggestion: "User dismissed the authentication dialog.",
    };
  }

  for (const { pattern, type, suggestion } of ERROR_PATTERNS) {
    if (pattern.test(combined)) {
      // Get context: 5 lines around the error
      const lines = combined.split("\n");
      const errorIndex = lines.findIndex(line => pattern.test(line));
      const start = Math.max(0, errorIndex - 2);
      const end = Math.min(lines.length, errorIndex + 3);
      const context = lines.slice(start, end).filter(l => l.trim());

      return { type, message: lines[errorIndex] || type, context, suggestion };
    }
  }

  // Unknown error
  if (stderr.trim()) {
    return {
      type: "unknown",
      message: "Command failed with error",
      context: stderr.split("\n").slice(-5).filter(l => l.trim()),
    };
  }

  return undefined;
}

async function sendErrorNotification(error: ErrorSummary, command: string): Promise<void> {
  try {
    const manager = getDialogManager();
    const contextStr = error.context.length > 0 ? `\n\n${error.context.join("\n")}` : "";
    const suggestionStr = error.suggestion ? `\n\nSuggestion: ${error.suggestion}` : "";

    await manager.notify({
      title: `Command Failed: ${error.type.replace(/_/g, " ")}`,
      message: `${error.message}${contextStr}${suggestionStr}`.slice(0, 500),
      urgency: "critical",
      timeout: 10,
    });
  } catch {
    // Ignore notification errors
  }
}

// List of AUR helpers that call sudo internally
const AUR_HELPERS = ["paru", "yay", "pikaur", "trizen", "aurman"];

function isAurHelper(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  return AUR_HELPERS.some(helper => firstWord === helper || firstWord.endsWith("/" + helper));
}

async function createAskpassScript(persistent: boolean = false): Promise<string> {
  const detection = getDialogBackend();
  const scriptPath = join(tmpdir(), `mcp-askpass-${Date.now()}.sh`);

  const display = process.env.DISPLAY || ":0";
  const xauthority = process.env.XAUTHORITY || `${process.env.HOME}/.Xauthority`;

  let dialogCommand: string;

  if (detection.backend === "kdialog") {
    dialogCommand = `kdialog --password "Enter sudo password"`;
  } else if (detection.backend === "zenity") {
    dialogCommand = `zenity --password --title="Sudo Authentication"`;
  } else {
    throw new Error("No dialog backend available for password prompt. Install kdialog or zenity.");
  }

  // Export display variables so GUI dialogs work from any user context
  const scriptContent = `#!/bin/bash
export DISPLAY="${display}"
export XAUTHORITY="${xauthority}"
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

  // Can't use -E with -i together
  if (params.preserveEnv && !params.loginShell) {
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
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.() || 1000}`;
  }

  return env;
}

function wrapCommandForNestedAskpass(command: string, askpassPath: string): string {
  // Set SUDO_ASKPASS for any nested sudo calls
  let wrappedCommand = `export SUDO_ASKPASS="${askpassPath}"; ${command}`;

  // If it's an AUR helper, add sudoflags to use askpass
  if (isAurHelper(command)) {
    // Check if --sudoflags is already present
    if (!command.includes("--sudoflags")) {
      // Insert --sudoflags=-A after the AUR helper command
      const parts = command.split(/\s+/);
      const helperIndex = parts.findIndex(p => AUR_HELPERS.some(h => p === h || p.endsWith("/" + h)));
      if (helperIndex !== -1) {
        parts.splice(helperIndex + 1, 0, "--sudoflags=-A");
        wrappedCommand = `export SUDO_ASKPASS="${askpassPath}"; ${parts.join(" ")}`;
      }
    }
  }

  return wrappedCommand;
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

          const cancelled = code === 1 && (
            stderr.includes("no askpass program") ||
            stderr.includes("password")
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
  runAsUser?: string,
  nestedAskpass?: boolean
): Promise<SudoExecuteResult> {
  let askpassScript: string | null = null;

  try {
    // Create askpass script if nested_askpass is enabled
    if (nestedAskpass) {
      askpassScript = await createAskpassScript(true);
    }

    return await new Promise<SudoExecuteResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let resolved = false;

      let finalCommand = command;

      // If running as specific user, wrap with sudo -u
      if (runAsUser) {
        if (nestedAskpass && askpassScript) {
          // Wrap command to set SUDO_ASKPASS for nested calls
          finalCommand = wrapCommandForNestedAskpass(command, askpassScript);
        }
        finalCommand = `sudo -u ${runAsUser} bash -c '${finalCommand.replace(/'/g, "'\\''")}'`;
      } else if (nestedAskpass && askpassScript) {
        // Even as root, if nested_askpass is set, wrap the command
        finalCommand = wrapCommandForNestedAskpass(command, askpassScript);
      }

      const pkexecArgs = ["bash", "-c", finalCommand];
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
  } finally {
    // Cleanup askpass script
    if (askpassScript) {
      try {
        await unlink(askpassScript);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

export async function sudoExecute(params: SudoExecuteParams): Promise<SudoExecuteResult> {
  const method = params.method || "askpass";
  const workingDir = params.working_dir || process.env.HOME || "/";
  const timeoutMs = (params.timeout ?? 120) * 1000;
  const notifyOnError = params.notify_on_error ?? true;

  // Auto-enable nested_askpass for AUR helpers if not explicitly set
  const nestedAskpass = params.nested_askpass ?? isAurHelper(params.command);

  let result: SudoExecuteResult;

  if (method === "pkexec") {
    result = await runWithPkexec(params.command, workingDir, timeoutMs, params.run_as_user, nestedAskpass);
  } else {
    result = await runWithAskpass(
      params.command,
      workingDir,
      timeoutMs,
      params.run_as_user,
      params.login_shell,
      params.preserve_env
    );
  }

  // Parse errors if command failed
  if (result.exit_code !== 0 || result.timed_out || result.cancelled) {
    const errorSummary = parseError(result.stdout, result.stderr, result.timed_out, result.cancelled);
    if (errorSummary) {
      result.error_summary = errorSummary;

      // Send desktop notification for errors
      if (notifyOnError) {
        await sendErrorNotification(errorSummary, params.command);
      }
    }
  }

  return result;
}

export const sudoExecuteToolDefinition = {
  name: "sudo_execute",
  description:
    "Execute a command with elevated privileges or as a specific user. Shows GUI password dialogs. Automatically handles nested sudo for AUR helpers (paru/yay).",
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
          "Run command as this user instead of root. Essential for AUR helpers (paru/yay) that refuse root.",
      },
      login_shell: {
        type: "boolean",
        description:
          "Use login shell (-i) to load target user's full environment. For askpass method only.",
      },
      preserve_env: {
        type: "boolean",
        description:
          "Preserve current environment variables (-E). For askpass method only, not with login_shell.",
      },
      nested_askpass: {
        type: "boolean",
        description:
          "Enable GUI password prompt for nested sudo calls (auto-enabled for paru/yay/pikaur).",
      },
      notify_on_error: {
        type: "boolean",
        description:
          "Send desktop notification when command fails with error details and suggestions (default: true).",
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
