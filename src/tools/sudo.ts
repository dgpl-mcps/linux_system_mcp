import { spawn, ChildProcess } from "child_process";
import { writeFile, unlink, chmod } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getDialogBackend } from "../utils/de-detect.js";
import { getDialogManager } from "../utils/dialog-backend.js";

export type SudoMethod = "askpass" | "pkexec" | "su" | "auto";

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
  { pattern: /Authentication failure/i, type: "auth_failed", suggestion: "Wrong password entered. Try again with correct password." },
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

// Truncate command for display (keep it readable)
function truncateCommand(command: string, maxLen: number = 80): string {
  const cleaned = command.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + '...';
}

// Check if current user can use sudo (quick test)
async function canCurrentUserSudo(): Promise<boolean> {
  return new Promise((resolve) => {
    // sudo -n = non-interactive, -v = validate (no command)
    // This checks if user has NOPASSWD or cached credentials
    const proc = spawn("sudo", ["-n", "-v"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.on("close", (code) => {
      // If exit 0, user can sudo without password (cached or NOPASSWD)
      // We'll still use askpass to prompt, but we know they're in sudoers
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });

    // Timeout after 2 seconds
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 2000);
  });
}

// Check if user is likely in sudoers (by group membership)
function isLikelyInSudoers(): boolean {
  try {
    const groups = process.env.GROUPS || "";
    // Common sudo groups: wheel, sudo, admin
    return /\b(wheel|sudo|admin)\b/.test(groups);
  } catch {
    return false;
  }
}

// Auto-detect the best authentication method
async function autoDetectMethod(runAsUser?: string): Promise<"askpass" | "pkexec" | "su"> {
  // If running as a different user, use 'su' to authenticate as them
  if (runAsUser && runAsUser !== "root") {
    return "su";
  }

  // Try to check if current user can sudo
  const canSudo = await canCurrentUserSudo();
  if (canSudo) {
    return "askpass";
  }

  // Check group membership as fallback hint
  if (isLikelyInSudoers()) {
    return "askpass";
  }

  // Default to pkexec (PolicyKit) as it works for any user
  return "pkexec";
}

// Send notification before showing password dialog
async function notifyBeforeAuth(command: string, runAsUser?: string): Promise<void> {
  try {
    const manager = getDialogManager();
    const truncated = truncateCommand(command, 100);
    const userInfo = runAsUser ? ` as ${runAsUser}` : "";

    await manager.notify({
      title: "Authentication Required",
      message: `Running${userInfo}:\n${truncated}`,
      urgency: "normal",
      timeout: 5,
    });
  } catch {
    // Ignore notification errors
  }
}

async function createAskpassScript(persistent: boolean = false, command?: string): Promise<string> {
  const detection = getDialogBackend();
  const scriptPath = join(tmpdir(), `mcp-askpass-${Date.now()}.sh`);

  const display = process.env.DISPLAY || ":0";
  const xauthority = process.env.XAUTHORITY || `${process.env.HOME}/.Xauthority`;

  // Add command context to the dialog
  const cmdInfo = command ? `\n\nCommand: ${truncateCommand(command, 60)}` : "";

  let dialogCommand: string;

  if (detection.backend === "kdialog") {
    dialogCommand = `kdialog --password "Enter sudo password${cmdInfo}"`;
  } else if (detection.backend === "zenity") {
    const title = command ? `Sudo: ${truncateCommand(command, 40)}` : "Sudo Authentication";
    dialogCommand = `zenity --password --title="${title}"`;
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
    // Send notification before showing password dialog
    await notifyBeforeAuth(command, runAsUser);

    askpassScript = await createAskpassScript(false, command);

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
    // Send notification before PolicyKit dialog
    await notifyBeforeAuth(command, runAsUser);

    // Create askpass script if nested_askpass is enabled
    if (nestedAskpass) {
      askpassScript = await createAskpassScript(true, command);
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

async function getPasswordViaDialog(username: string, command?: string): Promise<string | null> {
  const detection = getDialogBackend();
  const display = process.env.DISPLAY || ":0";
  const xauthority = process.env.XAUTHORITY || `${process.env.HOME}/.Xauthority`;

  // Add command context to dialog
  const cmdInfo = command ? `\n\nCommand: ${truncateCommand(command, 60)}` : "";

  return new Promise((resolve) => {
    let dialogCmd: string;
    let dialogArgs: string[];

    if (detection.backend === "kdialog") {
      dialogCmd = "kdialog";
      dialogArgs = ["--password", `Enter password for ${username}${cmdInfo}`];
    } else if (detection.backend === "zenity") {
      dialogCmd = "zenity";
      const title = command ? `Auth: ${truncateCommand(command, 30)}` : `Authentication for ${username}`;
      dialogArgs = ["--password", `--title=${title}`];
    } else {
      resolve(null);
      return;
    }

    const proc = spawn(dialogCmd, dialogArgs, {
      env: {
        ...process.env,
        DISPLAY: display,
        XAUTHORITY: xauthority,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let password = "";
    proc.stdout?.on("data", (data: Buffer) => {
      password += data.toString();
    });

    proc.on("close", (code) => {
      // Don't trim - passwords can have trailing spaces!
      if (code === 0 && password) {
        // Only remove trailing newline from dialog output, not spaces
        resolve(password.replace(/\n$/, ''));
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}

async function runWithSu(
  command: string,
  workingDir: string,
  timeoutMs: number,
  runAsUser: string,
  nestedAskpass?: boolean
): Promise<SudoExecuteResult> {
  let askpassScript: string | null = null;
  let suWrapperScript: string | null = null;

  // Send notification before showing password dialog
  await notifyBeforeAuth(command, runAsUser);

  // Get password via GUI dialog (with command context)
  const password = await getPasswordViaDialog(runAsUser, command);

  if (!password) {
    return {
      stdout: "",
      stderr: "Password dialog was cancelled or failed",
      exit_code: 1,
      timed_out: false,
      cancelled: true,
      method_used: "su",
      run_as: runAsUser,
    };
  }

  try {
    // Create askpass script if nested_askpass is enabled (for commands that call sudo internally)
    if (nestedAskpass) {
      askpassScript = await createAskpassScript(true, command);
    }

    let finalCommand = command;

    // If nested_askpass is enabled, wrap command to set SUDO_ASKPASS
    if (nestedAskpass && askpassScript) {
      finalCommand = wrapCommandForNestedAskpass(command, askpassScript);
    }

    // Create a wrapper script that uses expect-like behavior with coprocess
    const display = process.env.DISPLAY || ":0";
    const xauthority = process.env.XAUTHORITY || `${process.env.HOME}/.Xauthority`;

    // Escape the password for shell (handle special chars)
    const escapedPassword = password.replace(/'/g, "'\\''");
    const escapedCommand = finalCommand.replace(/'/g, "'\\''");

    suWrapperScript = join(tmpdir(), `mcp-su-wrapper-${Date.now()}.sh`);
    // Use Python's pty module for proper TTY handling (Python is nearly universal)
    const wrapperContent = `#!/usr/bin/env python3
import pty
import os
import sys
import select

os.environ['DISPLAY'] = '${display}'
os.environ['XAUTHORITY'] = '${xauthority}'

password = '${escapedPassword}'
command = ['su', '-', '${runAsUser}', '-c', 'cd "${workingDir}" && ${escapedCommand}']

def read_and_forward(fd):
    data = os.read(fd, 1024)
    return data

pid, master = pty.fork()
if pid == 0:
    # Child
    os.execvp(command[0], command)
else:
    # Parent
    password_sent = False
    output = b''
    try:
        while True:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 1024)
                    if not data:
                        break
                    output += data
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                    # Send password when prompted
                    if not password_sent and (b'assword:' in output or b'assword: ' in output):
                        os.write(master, (password + '\\n').encode())
                        password_sent = True
                except OSError:
                    break
            # Check if child exited
            result = os.waitpid(pid, os.WNOHANG)
            if result[0] != 0:
                # Read any remaining output
                try:
                    while True:
                        ready, _, _ = select.select([master], [], [], 0.1)
                        if not ready:
                            break
                        data = os.read(master, 1024)
                        if not data:
                            break
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                except:
                    pass
                sys.exit(os.WEXITSTATUS(result[1]) if os.WIFEXITED(result[1]) else 1)
    except KeyboardInterrupt:
        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`;
    await writeFile(suWrapperScript, wrapperContent, { mode: 0o700 });
    await chmod(suWrapperScript, 0o700);

    return await new Promise<SudoExecuteResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let resolved = false;

      const env = buildEnvForUser(runAsUser);

      const proc: ChildProcess = spawn("python3", [suWrapperScript!], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      proc.stdin?.end();

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

          // Clean up output from script command (removes control chars and password prompt)
          const cleanedStdout = stdout
            .split("\n")
            .filter(line =>
              !line.toLowerCase().includes("password:") &&
              !line.includes("Script started") &&
              !line.includes("Script done") &&
              line.trim() !== ""
            )
            .join("\n")
            .replace(/\r/g, "")
            .trim();

          const filteredStderr = stderr
            .split("\n")
            .filter(line => !line.toLowerCase().includes("password:"))
            .join("\n")
            .trim();

          const authFailed = stdout.includes("Authentication failure") ||
            stderr.includes("Authentication failure") ||
            stdout.includes("su: Authentication failure");

          resolve({
            stdout: cleanedStdout,
            stderr: filteredStderr,
            exit_code: authFailed ? 1 : (code ?? 1),
            timed_out: timedOut,
            cancelled: false,  // Auth failure is not cancellation
            method_used: "su",
            run_as: runAsUser,
          });
        }
      });

      proc.on("error", (err: Error) => {
        if (!resolved) {
          resolved = true;
          if (timeout) clearTimeout(timeout);
          resolve({
            stdout: "",
            stderr: err.message,
            exit_code: 1,
            timed_out: false,
            cancelled: false,
            method_used: "su",
            run_as: runAsUser,
          });
        }
      });

      proc.on("error", (err: Error) => {
        if (!resolved) {
          resolved = true;
          if (timeout) clearTimeout(timeout);
          resolve({
            stdout: "",
            stderr: err.message,
            exit_code: 1,
            timed_out: false,
            cancelled: false,
            method_used: "su",
            run_as: runAsUser || "root",
          });
        }
      });
    });
  } finally {
    if (askpassScript) {
      try { await unlink(askpassScript); } catch { /* ignore */ }
    }
    if (suWrapperScript) {
      try { await unlink(suWrapperScript); } catch { /* ignore */ }
    }
  }
}

export async function sudoExecute(params: SudoExecuteParams): Promise<SudoExecuteResult> {
  const requestedMethod = params.method || "auto";
  const rawTimeout = params.timeout ?? 30;
  const timeoutMs = rawTimeout === 0 ? 0 : rawTimeout * 1000;
  const notifyOnError = params.notify_on_error ?? true;

  // Auto-detect method if not specified or explicitly set to "auto"
  const method: "askpass" | "pkexec" | "su" = requestedMethod === "auto"
    ? await autoDetectMethod(params.run_as_user)
    : requestedMethod;

  // For su method with different user, default to their home (not current user's home)
  const defaultDir = (method === "su" && params.run_as_user)
    ? `/home/${params.run_as_user}`
    : (process.env.HOME || "/");
  const workingDir = params.working_dir || defaultDir;

  // Auto-enable nested_askpass for AUR helpers if not explicitly set
  const nestedAskpass = params.nested_askpass ?? isAurHelper(params.command);

  let result: SudoExecuteResult;

  if (method === "pkexec") {
    result = await runWithPkexec(params.command, workingDir, timeoutMs, params.run_as_user, nestedAskpass);
  } else if (method === "su") {
    // su method requires run_as_user
    const targetUser = params.run_as_user || "root";
    result = await runWithSu(params.command, workingDir, timeoutMs, targetUser, nestedAskpass);
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
    "Execute a command with root/sudo privileges. Default timeout is 30 seconds to prevent hanging. Recommended max timeout for long operations is 600 seconds (10 mins). Pass timeout: 0 for no timeout / unlimited execution duration (e.g. for heavy builds, large package installs, or long services). The agent can decide any timeout value in seconds based on task requirements.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      method: {
        type: "string",
        enum: ["auto", "askpass", "pkexec", "su"],
        description:
          "Authentication method (default: 'auto'). 'auto' picks best method: su for run_as_user, askpass if in sudoers, else pkexec. 'askpass' needs sudoers, 'pkexec' asks root, 'su' asks target user's password.",
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
        description: "Timeout in seconds (default: 30, recommended max: 600, pass 0 for no timeout/unlimited). The agent can pass any timeout value required by the task.",
      },
    },
    required: ["command"],
  },
};
