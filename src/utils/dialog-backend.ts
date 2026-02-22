import { spawn, execSync, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { getDialogBackend, DialogBackend } from "./de-detect.js";

export type Urgency = "low" | "normal" | "critical";

export interface NotifyOptions {
  title: string;
  message: string;
  urgency?: Urgency;
  timeout?: number; // in seconds
}

export interface ConfirmOptions {
  title: string;
  message: string;
}

export interface AlertOptions {
  title: string;
  message: string;
}

export interface ChoiceOptions {
  title: string;
  message: string;
  choices: string[];
}

export interface InputOptions {
  title: string;
  message: string;
  defaultValue?: string;
}

export interface ConfirmResult {
  confirmed: boolean;
}

export interface AlertResult {
  acknowledged: boolean;
}

export interface ChoiceResult {
  selected: string | null;
  index: number;
  cancelled: boolean;
}

export interface InputResult {
  input: string;
  cancelled: boolean;
}

// ============ ENVIRONMENT RESOLUTION ============

/**
 * When the MCP server is spawned from a browser/Chromium scope the process
 * environment often lacks DISPLAY, DBUS_SESSION_BUS_ADDRESS etc.
 * This function tries to recover those values from the running user session.
 */
function resolveSessionEnv(): Record<string, string> {
  const needed = {
    DISPLAY: process.env.DISPLAY ?? "",
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
    XAUTHORITY: process.env.XAUTHORITY ?? "",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
  };

  // Fast-path: if everything we need is already set, skip scanning
  const allSet = Object.values(needed).every(Boolean);
  if (allSet) {
    return needed as Record<string, string>;
  }

  // Try to pull vars from any running graphical session process of the same UID.
  // We look for common session processes: plasmashell, gnome-session, kwin, Xorg
  try {
    const uid = process.getuid?.() ?? -1;
    const sessionProcessNames = ["plasmashell", "gnome-session-b", "kwin_x11", "kwin_wayland", "Xorg", "Xwayland"];
    const procs = execFileSync("pgrep", ["-u", String(uid), "-f", sessionProcessNames.join("|")], {
      encoding: "utf8",
      timeout: 2000,
    }).trim().split("\n").filter(Boolean);

    for (const pid of procs) {
      const envPath = `/proc/${pid}/environ`;
      if (!existsSync(envPath)) continue;
      try {
        const raw = readFileSync(envPath, "utf8");
        const pairs = raw.split("\0").filter(Boolean);
        for (const pair of pairs) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) continue;
          const key = pair.slice(0, eqIdx);
          const val = pair.slice(eqIdx + 1);
          if (key in needed && !needed[key as keyof typeof needed]) {
            (needed as Record<string, string>)[key] = val;
          }
        }
        // Stop if we've filled everything
        if (Object.values(needed).every(Boolean)) break;
      } catch {
        // /proc/<pid>/environ may be unreadable for some pids — skip
      }
    }
  } catch {
    // pgrep may not be installed or may fail — not fatal
  }

  // Final fallback defaults
  if (!needed.DISPLAY) needed.DISPLAY = ":0";
  if (!needed.XDG_RUNTIME_DIR && process.getuid) {
    needed.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }

  return needed as Record<string, string>;
}

// ============ SANITISATION ============

/**
 * Strip null bytes and other dangerous control characters from user-supplied
 * strings before passing them as CLI arguments.  Some characters (e.g. \x00)
 * can truncate argument lists; others can trigger Qt assertion failures.
 */
function sanitize(text: string): string {
  // Remove null bytes and ASCII control chars except normal whitespace
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// ============ COMMAND RUNNER ============

function buildKdialogEnv(): Record<string, string> {
  return {
    ...resolveSessionEnv(),
    QT_QPA_PLATFORM: "xcb",
  };
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number = 30000,
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
        ...extraEnv,
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
        resolve({ stdout: stdout.trim(), exitCode: 124 });
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // Signal-caused exits (e.g. SIGABRT = 6 → exitCode 134) get a
        // distinct non-zero code so callers can detect crash vs user cancel.
        const exitCode = code !== null ? code : signal ? 128 + (signalToNum(signal) || 1) : 1;
        resolve({ stdout: stdout.trim(), exitCode });
      }
    });

    proc.on("error", (_err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: "", exitCode: 127 }); // 127 = command not found convention
      }
    });
  });
}

function signalToNum(signal: string): number {
  const map: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9,
    SIGTERM: 15, SIGSEGV: 11, SIGPIPE: 13,
  };
  return map[signal] ?? 0;
}

/** Returns true when the exit code indicates a signal-caused crash. */
function isCrashExit(code: number): boolean {
  // 128+N means killed by signal N; 1 = general error for proc.on("error")
  return code >= 128 || code === 127;
}

/** Check at runtime whether a given command is available on PATH. */
function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ============ KDIALOG IMPLEMENTATION ============

/**
 * Run kdialog with QT_QPA_PLATFORM=xcb and a fully-resolved session
 * environment so it works even when launched from a Chromium browser scope.
 */
function runKdialog(args: string[], timeoutMs?: number): Promise<{ stdout: string; exitCode: number }> {
  return runCommand("kdialog", args, timeoutMs, buildKdialogEnv());
}

async function kdialogNotify(options: NotifyOptions): Promise<void> {
  const timeout = options.timeout ?? 5;
  const args = [
    "--passivepopup",
    sanitize(`${options.title}\n\n${options.message}`),
    String(timeout),
  ];
  const result = await runKdialog(args);
  if (result.exitCode !== 0) {
    // Crashed or failed — try notify-send, then stderr as last resort
    await notifySendNotify(options, /*isFallback=*/true);
  }
}

async function kdialogConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const args = [
    "--title", sanitize(options.title),
    "--yesno", sanitize(options.message),
  ];
  const result = await runKdialog(args);

  // Retry once on crash (transient Qt/display init issue)
  if (isCrashExit(result.exitCode)) {
    await sleep(150);
    const retry = await runKdialog(args);
    if (isCrashExit(retry.exitCode)) {
      throw new Error(`kdialog crashed twice (exit ${retry.exitCode}). Try running: QT_QPA_PLATFORM=xcb kdialog --yesno "test"`);
    }
    return { confirmed: retry.exitCode === 0 };
  }

  return { confirmed: result.exitCode === 0 };
}

async function kdialogAlert(options: AlertOptions): Promise<AlertResult> {
  const args = [
    "--title", sanitize(options.title),
    "--msgbox", sanitize(options.message),
  ];
  const result = await runKdialog(args);

  // Retry once on crash
  if (isCrashExit(result.exitCode)) {
    await sleep(150);
    const retry = await runKdialog(args);
    if (isCrashExit(retry.exitCode)) {
      // If interactive dialog is unavailable, at least send a notification
      await notifySendNotify({ title: options.title, message: options.message }, true);
      return { acknowledged: false };
    }
    return { acknowledged: retry.exitCode === 0 };
  }

  return { acknowledged: result.exitCode === 0 };
}

async function kdialogChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) {
    return { selected: null, index: -1, cancelled: true };
  }

  const args = [
    "--title", sanitize(options.title),
    "--menu", sanitize(options.message),
  ];

  options.choices.forEach((choice, index) => {
    args.push(String(index), sanitize(choice));
  });

  let result = await runKdialog(args);

  // Retry once on crash
  if (isCrashExit(result.exitCode)) {
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      throw new Error(`kdialog crashed (exit ${result.exitCode}) showing menu dialog.`);
    }
  }

  if (result.exitCode !== 0) {
    return { selected: null, index: -1, cancelled: true };
  }

  const selectedIndex = parseInt(result.stdout, 10);
  if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= options.choices.length) {
    return { selected: null, index: -1, cancelled: true };
  }

  return {
    selected: options.choices[selectedIndex],
    index: selectedIndex,
    cancelled: false,
  };
}

async function kdialogInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--title", sanitize(options.title),
    "--inputbox", sanitize(options.message),
    sanitize(options.defaultValue || ""),
  ];

  let result = await runKdialog(args);

  // Retry once on crash
  if (isCrashExit(result.exitCode)) {
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      throw new Error(`kdialog crashed (exit ${result.exitCode}) showing input dialog.`);
    }
  }

  if (result.exitCode !== 0) {
    return { input: "", cancelled: true };
  }

  return { input: result.stdout, cancelled: false };
}

// ============ ZENITY IMPLEMENTATION ============

async function zenityNotify(options: NotifyOptions): Promise<void> {
  // Prefer notify-send (lighter, respects D-Bus notification daemon)
  if (isCommandAvailable("notify-send")) {
    return notifySendNotify(options);
  }
  const args = [
    "--notification",
    "--text", sanitize(`${options.title}\n${options.message}`),
  ];
  const result = await runCommand("zenity", args, 8000, resolveSessionEnv());
  if (result.exitCode !== 0) {
    logFallback("zenity notify", options);
  }
}

async function zenityConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const args = [
    "--question",
    "--title", sanitize(options.title),
    "--text", sanitize(options.message),
    "--width", "400",
  ];
  const result = await runCommand("zenity", args, 60000, resolveSessionEnv());
  return { confirmed: result.exitCode === 0 };
}

async function zenityAlert(options: AlertOptions): Promise<AlertResult> {
  const args = [
    "--info",
    "--title", sanitize(options.title),
    "--text", sanitize(options.message),
    "--width", "400",
  ];
  const result = await runCommand("zenity", args, 60000, resolveSessionEnv());
  return { acknowledged: result.exitCode === 0 };
}

async function zenityChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) {
    return { selected: null, index: -1, cancelled: true };
  }

  const args = [
    "--list",
    "--radiolist",
    "--title", sanitize(options.title),
    "--text", sanitize(options.message),
    "--column", "Select",
    "--column", "Option",
    "--width", "400",
    "--height", "300",
  ];

  options.choices.forEach((choice, index) => {
    args.push(index === 0 ? "TRUE" : "FALSE", sanitize(choice));
  });

  const result = await runCommand("zenity", args, 60000, resolveSessionEnv());

  if (result.exitCode !== 0 || !result.stdout) {
    return { selected: null, index: -1, cancelled: true };
  }

  const selected = result.stdout;
  const index = options.choices.indexOf(selected);

  return { selected: index !== -1 ? selected : null, index, cancelled: false };
}

async function zenityInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--entry",
    "--title", sanitize(options.title),
    "--text", sanitize(options.message),
    "--width", "400",
  ];

  if (options.defaultValue) {
    args.push("--entry-text", sanitize(options.defaultValue));
  }

  const result = await runCommand("zenity", args, 60000, resolveSessionEnv());

  if (result.exitCode !== 0) {
    return { input: "", cancelled: true };
  }

  return { input: result.stdout, cancelled: false };
}

// ============ NOTIFY-SEND IMPLEMENTATION ============

async function notifySendNotify(options: NotifyOptions, isFallback = false): Promise<void> {
  const urgencyMap: Record<Urgency, string> = {
    low: "low",
    normal: "normal",
    critical: "critical",
  };

  if (!isCommandAvailable("notify-send")) {
    if (isFallback) {
      logFallback("notify-send", options);
    } else {
      throw new Error("notify-send is not installed.");
    }
    return;
  }

  const args = [
    "-u", urgencyMap[options.urgency || "normal"],
    "-t", String((options.timeout ?? 5) * 1000),
    sanitize(options.title),
    sanitize(options.message),
  ];

  const env = resolveSessionEnv();
  const result = await runCommand("notify-send", args, 5000, env);

  if (result.exitCode !== 0) {
    // Last resort: write to stderr so something is always observable
    logFallback("notify-send", options);
  }
}

// ============ SHARED UTILITIES ============

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Emit a structured log to stderr when all notification paths fail. */
function logFallback(failedBackend: string, options: NotifyOptions | AlertOptions): void {
  const msg = "message" in options ? options.message : "";
  process.stderr.write(
    `[linux-system-mcp] NOTIFICATION (${failedBackend} failed) — ${options.title}: ${msg}\n`
  );
}

// ============ PUBLIC API ============

export class DialogManager {
  private backend: DialogBackend;
  private supportsDialogs: boolean;

  constructor() {
    const detection = getDialogBackend();
    this.backend = detection.backend;
    this.supportsDialogs = detection.supportsDialogs;
  }

  getBackend(): DialogBackend {
    return this.backend;
  }

  canShowDialogs(): boolean {
    return this.supportsDialogs;
  }

  /** Returns true when at least one notification mechanism is available. */
  canNotify(): boolean {
    return (
      isCommandAvailable("kdialog") ||
      isCommandAvailable("notify-send") ||
      isCommandAvailable("zenity")
    );
  }

  async notify(options: NotifyOptions): Promise<void> {
    if (this.backend === "kdialog") {
      return kdialogNotify(options);
    } else if (this.backend === "zenity") {
      return zenityNotify(options);
    } else {
      return notifySendNotify(options);
    }
  }

  /**
   * Show a message with a single OK button (no yes/no).
   * Falls back to notify-send on kdialog crash.
   */
  async alert(options: AlertOptions): Promise<AlertResult> {
    if (!this.supportsDialogs) {
      // Best effort: use notify so the user at least sees the message
      await this.notify({ title: options.title, message: options.message }).catch(() => { });
      return { acknowledged: false };
    }
    if (this.backend === "kdialog") {
      return kdialogAlert(options);
    } else {
      return zenityAlert(options);
    }
  }

  async confirm(options: ConfirmOptions): Promise<ConfirmResult> {
    if (!this.supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. Please install one: sudo pacman -S kdialog (for KDE) or sudo pacman -S zenity"
      );
    }
    if (this.backend === "kdialog") {
      return kdialogConfirm(options);
    } else {
      return zenityConfirm(options);
    }
  }

  async choice(options: ChoiceOptions): Promise<ChoiceResult> {
    if (!this.supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. Please install one: sudo pacman -S kdialog (for KDE) or sudo pacman -S zenity"
      );
    }
    if (options.choices.length === 0) {
      return { selected: null, index: -1, cancelled: true };
    }
    if (this.backend === "kdialog") {
      return kdialogChoice(options);
    } else {
      return zenityChoice(options);
    }
  }

  async input(options: InputOptions): Promise<InputResult> {
    if (!this.supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. Please install one: sudo pacman -S kdialog (for KDE) or sudo pacman -S zenity"
      );
    }
    if (this.backend === "kdialog") {
      return kdialogInput(options);
    } else {
      return zenityInput(options);
    }
  }
}

// Singleton instance
let dialogManager: DialogManager | null = null;

export function getDialogManager(): DialogManager {
  if (!dialogManager) {
    dialogManager = new DialogManager();
  }
  return dialogManager;
}
