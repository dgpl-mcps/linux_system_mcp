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

// ============ CONSTANTS ============

const MAX_TITLE_LEN = 120;
const MAX_BODY_LEN = 2000;
/** After this many consecutive kdialog crashes, downgrade to zenity/notify. */
const KDIALOG_CRASH_THRESHOLD = 3;

// ============ ENVIRONMENT RESOLUTION ============

/** Cached resolved session env — populated on first call. */
let _resolvedEnvCache: Record<string, string> | null = null;

/**
 * When the MCP server is spawned from a browser/Chromium scope the process
 * environment often lacks DISPLAY, DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY
 * etc.  This function recovers those values by scanning `/proc/<pid>/environ`
 * of the user's own graphical session processes.  Result is cached for the
 * lifetime of the process.
 */
function resolveSessionEnv(): Record<string, string> {
  if (_resolvedEnvCache) return _resolvedEnvCache;

  const needed: Record<string, string> = {
    DISPLAY: process.env.DISPLAY ?? "",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "",
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
    XAUTHORITY: process.env.XAUTHORITY ?? "",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
  };

  // Fast-path: if everything is already set, skip scanning.
  if (Object.values(needed).every(Boolean)) {
    _resolvedEnvCache = needed;
    return needed;
  }

  // Scan /proc/<pid>/environ of graphical-session processes owned by this UID.
  try {
    const uid = process.getuid?.() ?? -1;
    const sessionProcs = [
      "plasmashell", "gnome-session-b", "kwin_x11", "kwin_wayland",
      "Xorg", "Xwayland", "sway", "hyprland", "mutter",
    ];
    const procs = execFileSync(
      "pgrep", ["-u", String(uid), "-f", sessionProcs.join("|")],
      { encoding: "utf8", timeout: 2000 }
    ).trim().split("\n").filter(Boolean);

    for (const pid of procs) {
      const envPath = `/proc/${pid}/environ`;
      if (!existsSync(envPath)) continue;
      try {
        const raw = readFileSync(envPath, "utf8");
        for (const pair of raw.split("\0").filter(Boolean)) {
          const eq = pair.indexOf("=");
          if (eq === -1) continue;
          const k = pair.slice(0, eq);
          const v = pair.slice(eq + 1);
          if (k in needed && !needed[k]) needed[k] = v;
        }
        if (Object.values(needed).every(Boolean)) break;
      } catch { /* /proc/<pid>/environ may not be readable — skip */ }
    }
  } catch { /* pgrep not available or no matching processes — not fatal */ }

  // Hardened fallbacks
  if (!needed.DISPLAY && !needed.WAYLAND_DISPLAY) needed.DISPLAY = ":0";
  if (!needed.XDG_RUNTIME_DIR && process.getuid) {
    needed.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }

  _resolvedEnvCache = needed;
  return needed;
}

// ============ SANITISATION & TRUNCATION ============

/**
 * Strip null bytes and dangerous ASCII control characters from strings before
 * passing them as CLI arguments.  Some control chars trigger Qt assertion
 * failures or silently truncate argument lists at the shell layer.
 */
function sanitize(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Truncate a string to `max` characters, appending an ellipsis if cut.
 * Prevents very long arguments from crashing Qt's arg parser.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/** Apply sanitize + truncate for title fields. */
function prepTitle(t: string): string {
  return truncate(sanitize(t), MAX_TITLE_LEN);
}

/** Apply sanitize + truncate for body/message fields. */
function prepBody(t: string): string {
  return truncate(sanitize(t), MAX_BODY_LEN);
}

// ============ COMMAND RUNNER ============

/**
 * Build the environment to use for kdialog invocations.
 * - Auto-detects Wayland vs X11 to set the correct QT_QPA_PLATFORM.
 * - Merges the resolved session environment so all required vars are present.
 */
function buildKdialogEnv(): Record<string, string> {
  const session = resolveSessionEnv();
  // Prefer Wayland when WAYLAND_DISPLAY is set; fall back to xcb (X11).
  const qtPlatform = session.WAYLAND_DISPLAY ? "wayland" : "xcb";
  return { ...session, QT_QPA_PLATFORM: qtPlatform };
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
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        resolve({ stdout: stdout.trim(), exitCode: 124 });
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", () => { /* swallow — we don't need stderr output */ });

    proc.on("close", (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        const exitCode =
          code !== null ? code : signal ? 128 + (signalToNum(signal) || 1) : 1;
        resolve({ stdout: stdout.trim(), exitCode });
      }
    });

    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: "", exitCode: 127 }); // 127 = command not found
      }
    });
  });
}

function signalToNum(signal: string): number {
  const map: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6,
    SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15,
  };
  return map[signal] ?? 0;
}

/** Returns true when the exit code indicates a signal-caused crash or spawn error. */
function isCrashExit(code: number): boolean {
  return code >= 128 || code === 127;
}

/** Check at runtime whether a given command is on PATH. */
function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ============ KDIALOG CRASH TRACKING / AUTO-DOWNGRADE ============

let kdialogCrashCount = 0;
/**
 * After KDIALOG_CRASH_THRESHOLD consecutive crashes, kdialog is likely
 * permanently broken in this session.  DialogManager watches this flag.
 */
export function isKdialogBlacklisted(): boolean {
  return kdialogCrashCount >= KDIALOG_CRASH_THRESHOLD;
}

function recordKdialogCrash(): void {
  kdialogCrashCount++;
  if (kdialogCrashCount === KDIALOG_CRASH_THRESHOLD) {
    process.stderr.write(
      `[linux-system-mcp] kdialog has crashed ${KDIALOG_CRASH_THRESHOLD} times — ` +
      `permanently downgrading to zenity/notify-send for this session.\n`
    );
    // Force the singleton to rebuild with the new effective backend.
    dialogManager = null;
  }
}

function recordKdialogSuccess(): void {
  // A successful call resets the crash streak so a single bad run
  // doesn't permanently ban kdialog.
  if (kdialogCrashCount > 0) kdialogCrashCount = 0;
}

// ============ KDIALOG IMPLEMENTATION ============

/**
 * Run kdialog with the correct QT_QPA_PLATFORM and full session environment.
 * If DBUS_SESSION_BUS_ADDRESS is still missing after session resolution,
 * wraps the call with `dbus-launch` to provide a temporary bus.
 */
async function runKdialog(
  args: string[],
  timeoutMs?: number
): Promise<{ stdout: string; exitCode: number }> {
  const env = buildKdialogEnv();

  // If we still have no D-Bus session, try dbus-launch to provide one.
  if (!env.DBUS_SESSION_BUS_ADDRESS && isCommandAvailable("dbus-launch")) {
    // dbus-launch --exit-with-session <cmd> [args...]
    return runCommand(
      "dbus-launch",
      ["--exit-with-session", "kdialog", ...args],
      timeoutMs,
      env
    );
  }

  return runCommand("kdialog", args, timeoutMs, env);
}

async function kdialogNotify(options: NotifyOptions): Promise<void> {
  const timeout = options.timeout ?? 5;
  const body = prepBody(`${prepTitle(options.title)}\n\n${prepBody(options.message)}`);
  const args = ["--passivepopup", body, String(timeout)];

  const result = await runKdialog(args);
  if (result.exitCode === 0) {
    recordKdialogSuccess();
    return;
  }

  if (isCrashExit(result.exitCode)) recordKdialogCrash();
  // Fall through to notify-send → dbus-send → stderr
  await notifySendNotify(options, /*isFallback=*/true);
}

async function kdialogConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const args = ["--title", prepTitle(options.title), "--yesno", prepBody(options.message)];
  let result = await runKdialog(args);

  if (isCrashExit(result.exitCode)) {
    recordKdialogCrash();
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      recordKdialogCrash();
      // xmessage fallback for confirm
      if (isCommandAvailable("xmessage")) {
        return xmessageConfirm(options);
      }
      throw new Error(
        `kdialog crashed repeatedly (exit ${result.exitCode}). ` +
        `Try: QT_QPA_PLATFORM=xcb kdialog --yesno "test"`
      );
    }
  }

  if (result.exitCode === 0) recordKdialogSuccess();
  return { confirmed: result.exitCode === 0 };
}

async function kdialogAlert(options: AlertOptions): Promise<AlertResult> {
  const args = ["--title", prepTitle(options.title), "--msgbox", prepBody(options.message)];
  let result = await runKdialog(args);

  if (isCrashExit(result.exitCode)) {
    recordKdialogCrash();
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      recordKdialogCrash();
      // xmessage fallback for alert
      if (isCommandAvailable("xmessage")) {
        return xmessageAlert(options);
      }
      // Last resort: at least deliver the notification
      await notifySendNotify({ title: options.title, message: options.message }, true);
      return { acknowledged: false };
    }
  }

  if (result.exitCode === 0) recordKdialogSuccess();
  return { acknowledged: result.exitCode === 0 };
}

async function kdialogChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true };

  const args = ["--title", prepTitle(options.title), "--menu", prepBody(options.message)];
  options.choices.forEach((c, i) => args.push(String(i), prepBody(c)));

  let result = await runKdialog(args);

  if (isCrashExit(result.exitCode)) {
    recordKdialogCrash();
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      recordKdialogCrash();
      throw new Error(`kdialog crashed showing menu dialog (exit ${result.exitCode}).`);
    }
  }

  if (result.exitCode !== 0) return { selected: null, index: -1, cancelled: true };

  recordKdialogSuccess();
  const idx = parseInt(result.stdout, 10);
  if (isNaN(idx) || idx < 0 || idx >= options.choices.length) {
    return { selected: null, index: -1, cancelled: true };
  }
  return { selected: options.choices[idx], index: idx, cancelled: false };
}

async function kdialogInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--title", prepTitle(options.title),
    "--inputbox", prepBody(options.message),
    prepBody(options.defaultValue || ""),
  ];

  let result = await runKdialog(args);

  if (isCrashExit(result.exitCode)) {
    recordKdialogCrash();
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      recordKdialogCrash();
      throw new Error(`kdialog crashed showing input dialog (exit ${result.exitCode}).`);
    }
  }

  if (result.exitCode !== 0) return { input: "", cancelled: true };

  recordKdialogSuccess();
  return { input: result.stdout, cancelled: false };
}

// ============ XMESSAGE FALLBACK (pure X11, no Qt/GTK) ============

/**
 * xmessage is a minimal X11 dialog shipped with most distros (xorg-xmessage).
 * It only needs DISPLAY — no runtime libraries beyond libX11.
 * Used as last-resort fallback when kdialog AND zenity are both unavailable/broken.
 */
async function xmessageConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const env = resolveSessionEnv();
  const text = `${prepTitle(options.title)}\n\n${prepBody(options.message)}`;
  const result = await runCommand(
    "xmessage",
    ["-buttons", "Yes:0,No:1", "-default", "No", text],
    60000,
    env
  );
  return { confirmed: result.exitCode === 0 };
}

async function xmessageAlert(options: AlertOptions): Promise<AlertResult> {
  const env = resolveSessionEnv();
  const text = `${prepTitle(options.title)}\n\n${prepBody(options.message)}`;
  const result = await runCommand(
    "xmessage",
    ["-buttons", "OK:0", "-default", "OK", text],
    60000,
    env
  );
  return { acknowledged: result.exitCode === 0 };
}

// ============ ZENITY IMPLEMENTATION ============

async function zenityNotify(options: NotifyOptions): Promise<void> {
  // Prefer the lighter notify-send over zenity's notification mode.
  if (isCommandAvailable("notify-send")) {
    return notifySendNotify(options);
  }
  const env = resolveSessionEnv();
  const result = await runCommand(
    "zenity",
    ["--notification", "--text", prepBody(`${prepTitle(options.title)}\n${prepBody(options.message)}`)],
    8000,
    env
  );
  if (result.exitCode !== 0) {
    await dbusNotify(options);
  }
}

async function zenityConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const env = resolveSessionEnv();
  const result = await runCommand(
    "zenity",
    ["--question", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000,
    env
  );
  if (isCrashExit(result.exitCode) && isCommandAvailable("xmessage")) {
    return xmessageConfirm(options);
  }
  return { confirmed: result.exitCode === 0 };
}

async function zenityAlert(options: AlertOptions): Promise<AlertResult> {
  const env = resolveSessionEnv();
  const result = await runCommand(
    "zenity",
    ["--info", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000,
    env
  );
  if (isCrashExit(result.exitCode) && isCommandAvailable("xmessage")) {
    return xmessageAlert(options);
  }
  return { acknowledged: result.exitCode === 0 };
}

async function zenityChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true };

  const env = resolveSessionEnv();
  const args = [
    "--list", "--radiolist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select",
    "--column", "Option",
    "--width", "400",
    "--height", "300",
  ];
  options.choices.forEach((c, i) => args.push(i === 0 ? "TRUE" : "FALSE", prepBody(c)));

  const result = await runCommand("zenity", args, 60000, env);
  if (result.exitCode !== 0 || !result.stdout) return { selected: null, index: -1, cancelled: true };

  const selected = result.stdout;
  const index = options.choices.indexOf(selected);
  return { selected: index !== -1 ? selected : null, index, cancelled: false };
}

async function zenityInput(options: InputOptions): Promise<InputResult> {
  const env = resolveSessionEnv();
  const args = [
    "--entry",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--width", "400",
  ];
  if (options.defaultValue) args.push("--entry-text", prepBody(options.defaultValue));

  const result = await runCommand("zenity", args, 60000, env);
  if (result.exitCode !== 0) return { input: "", cancelled: true };
  return { input: result.stdout, cancelled: false };
}

// ============ NOTIFY-SEND IMPLEMENTATION ============

async function notifySendNotify(options: NotifyOptions, isFallback = false): Promise<void> {
  if (!isCommandAvailable("notify-send")) {
    // Slide down to dbus-send as the next layer
    return dbusNotify(options, /*isFallback=*/isFallback);
  }

  const urgencyMap: Record<Urgency, string> = { low: "low", normal: "normal", critical: "critical" };
  const args = [
    "-u", urgencyMap[options.urgency || "normal"],
    "-t", String((options.timeout ?? 5) * 1000),
    prepTitle(options.title),
    prepBody(options.message),
  ];

  const result = await runCommand("notify-send", args, 5000, resolveSessionEnv());
  if (result.exitCode !== 0) {
    await dbusNotify(options, /*isFallback=*/true);
  }
}

// ============ DBUS-SEND NATIVE NOTIFICATION ============

/**
 * Speak the org.freedesktop.Notifications D-Bus interface directly via
 * `dbus-send`.  No notification daemon wrapper binary needed — just a working
 * D-Bus session bus and a listening daemon (dunst, mako, KDE plasma-nm, etc.).
 *
 * This slots between notify-send and the final stderr fallback.
 */
async function dbusNotify(options: NotifyOptions, isFallback = false): Promise<void> {
  if (!isCommandAvailable("dbus-send")) {
    logFallback("dbus-send (not installed)", options);
    return;
  }

  const env = resolveSessionEnv();
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    logFallback("dbus-send (no DBUS_SESSION_BUS_ADDRESS)", options);
    return;
  }

  const urgencyMap: Record<Urgency, number> = { low: 0, normal: 1, critical: 2 };
  const urgencyByte = urgencyMap[options.urgency || "normal"];
  const timeoutMs = (options.timeout ?? 5) * 1000;

  // org.freedesktop.Notifications.Notify signature:
  //   app_name summary body actions hints expire_timeout
  const args = [
    "--session",
    "--dest=org.freedesktop.Notifications",
    "--type=method_call",
    "/org/freedesktop/Notifications",
    "org.freedesktop.Notifications.Notify",
    `string:linux-system-mcp`,          // app_name
    `uint32:0`,                          // replaces_id
    `string:`,                           // app_icon
    `string:${prepTitle(options.title)}`, // summary
    `string:${prepBody(options.message)}`, // body
    `array:string:`,                     // actions
    `dict:string:variant:,byte:urgency,byte:${urgencyByte}`, // hints
    `int32:${timeoutMs}`,               // expire_timeout
  ];

  const result = await runCommand("dbus-send", args, 5000, env);
  if (result.exitCode !== 0) {
    logFallback("dbus-send", options);
  }
}

// ============ SHARED UTILITIES ============

/** Emit a structured message to stderr — the guaranteed last-resort fallback. */
function logFallback(failedBackend: string, options: NotifyOptions | AlertOptions): void {
  const msg = "message" in options ? options.message : "";
  process.stderr.write(
    `[linux-system-mcp] NOTIFICATION (${failedBackend} failed) — ${options.title}: ${msg}\n`
  );
}

// ============ EFFECTIVE BACKEND RESOLUTION ============

/**
 * Determine which backend to actually use right now, accounting for
 * kdialog auto-downgrade due to repeated crashes.
 */
function resolveEffectiveBackend(
  detectedBackend: DialogBackend,
  available: { kdialog: boolean; zenity: boolean; notifySend: boolean }
): { backend: DialogBackend; supportsDialogs: boolean } {
  if (detectedBackend === "kdialog" && isKdialogBlacklisted()) {
    // Downgrade: try zenity, then notify-send-only
    if (available.zenity) {
      return { backend: "zenity", supportsDialogs: true };
    }
    if (available.notifySend) {
      return { backend: "notify-send-only", supportsDialogs: false };
    }
  }
  const supportsDialogs =
    detectedBackend !== "notify-send-only" &&
    !(detectedBackend === "kdialog" && isKdialogBlacklisted());
  return { backend: detectedBackend, supportsDialogs };
}

// ============ PUBLIC API ============

export class DialogManager {
  private _detectedBackend: DialogBackend;
  private _available: { kdialog: boolean; zenity: boolean; notifySend: boolean };

  constructor() {
    const detection = getDialogBackend();
    this._detectedBackend = detection.backend;
    this._available = detection.available;
  }

  /** The backend currently in use (may differ from detected if kdialog is blacklisted). */
  getBackend(): DialogBackend {
    return resolveEffectiveBackend(this._detectedBackend, this._available).backend;
  }

  canShowDialogs(): boolean {
    return resolveEffectiveBackend(this._detectedBackend, this._available).supportsDialogs;
  }

  /** Returns true when at least one notification mechanism is available. */
  canNotify(): boolean {
    return (
      isCommandAvailable("kdialog") ||
      isCommandAvailable("notify-send") ||
      isCommandAvailable("zenity") ||
      isCommandAvailable("dbus-send")
    );
  }

  async notify(options: NotifyOptions): Promise<void> {
    const { backend } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (backend === "kdialog") return kdialogNotify(options);
    if (backend === "zenity") return zenityNotify(options);
    return notifySendNotify(options);
  }

  /**
   * Show a message with a single OK button.
   * Falls through: kdialog → xmessage → notify-send → dbus-send → stderr.
   */
  async alert(options: AlertOptions): Promise<AlertResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      await this.notify({ title: options.title, message: options.message }).catch(() => { });
      return { acknowledged: false };
    }
    if (backend === "kdialog") return kdialogAlert(options);
    return zenityAlert(options);
  }

  async confirm(options: ConfirmOptions): Promise<ConfirmResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. " +
        "Install one: sudo pacman -S kdialog  (KDE)  or  sudo pacman -S zenity"
      );
    }
    if (backend === "kdialog") return kdialogConfirm(options);
    return zenityConfirm(options);
  }

  async choice(options: ChoiceOptions): Promise<ChoiceResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. " +
        "Install one: sudo pacman -S kdialog  (KDE)  or  sudo pacman -S zenity"
      );
    }
    if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true };
    if (backend === "kdialog") return kdialogChoice(options);
    return zenityChoice(options);
  }

  async input(options: InputOptions): Promise<InputResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. " +
        "Install one: sudo pacman -S kdialog  (KDE)  or  sudo pacman -S zenity"
      );
    }
    if (backend === "kdialog") return kdialogInput(options);
    return zenityInput(options);
  }
}

// Singleton — nulled when kdialog is blacklisted to force backend re-resolution.
let dialogManager: DialogManager | null = null;

export function getDialogManager(): DialogManager {
  if (!dialogManager) {
    dialogManager = new DialogManager();
  }
  return dialogManager;
}
