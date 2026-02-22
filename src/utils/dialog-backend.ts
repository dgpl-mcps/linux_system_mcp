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

export interface PasswordOptions {
  title: string;
  message: string;
}

export interface PasswordResult {
  password: string;
  cancelled: boolean;
}

// ============ CONSTANTS ============

const MAX_TITLE_LEN = 120;
const MAX_BODY_LEN = 2000;
/** After this many consecutive kdialog crashes, permanently downgrade. */
const KDIALOG_CRASH_THRESHOLD = 3;
/** Suppress duplicate notifications with the same title+message within this window. */
const NOTIFY_DEDUP_WINDOW_MS = 3000;

// ============ NOTIFICATION RATE LIMITING ============

/**
 * Simple in-memory deduplication for passive notifications.
 * If the same title+message arrives within NOTIFY_DEDUP_WINDOW_MS ms
 * the second call is silently dropped (and reports "dedup" as the method).
 * This prevents notification floods from LLM retry loops.
 */
const _recentNotifications = new Map<string, number>(); // key → timestamp

function isDuplicateNotify(title: string, message: string): boolean {
  const key = `${title}\x00${message}`;
  const now = Date.now();
  const last = _recentNotifications.get(key);
  if (last !== undefined && now - last < NOTIFY_DEDUP_WINDOW_MS) return true;
  _recentNotifications.set(key, now);
  // Prune stale entries occasionally to avoid unbounded growth
  if (_recentNotifications.size > 100) {
    for (const [k, ts] of _recentNotifications) {
      if (now - ts > NOTIFY_DEDUP_WINDOW_MS * 2) _recentNotifications.delete(k);
    }
  }
  return false;
}

// ============ COMMAND AVAILABILITY CACHE ============

/** Caches `which <cmd>` results to avoid repeated synchronous subprocess calls. */
const _cmdAvailCache = new Map<string, boolean>();

function isCommandAvailable(cmd: string): boolean {
  if (_cmdAvailCache.has(cmd)) return _cmdAvailCache.get(cmd)!;
  try {
    execSync(`which ${cmd}`, { stdio: "ignore", timeout: 2000 });
    _cmdAvailCache.set(cmd, true);
    return true;
  } catch {
    _cmdAvailCache.set(cmd, false);
    return false;
  }
}

// ============ ENVIRONMENT RESOLUTION ============

/** Cached resolved session env — populated on first call. */
let _resolvedEnvCache: Record<string, string> | null = null;

/**
 * When the MCP server is spawned from a browser/Chromium scope the process
 * environment often lacks DISPLAY, DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY
 * etc.  This function recovers those values by:
 *  1. Scanning /proc/<pid>/environ of the user's own session processes
 *  2. Querying `systemctl --user show-environment` (reliable on systemd desktops)
 *  3. Applying safe hardcoded last-resort defaults
 * Result is cached for the lifetime of the process.
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

  const isFull = () => Object.values(needed).every(Boolean);
  if (isFull()) { _resolvedEnvCache = needed; return needed; }

  // ── Source 1: /proc/<pid>/environ of session processes ────────────────────
  try {
    const uid = process.getuid?.() ?? -1;
    const sessionProcs = [
      "plasmashell", "gnome-session-b", "kwin_x11", "kwin_wayland",
      "Xorg", "Xwayland", "sway", "hyprland", "mutter", "openbox",
    ];
    const pids = execFileSync(
      "pgrep", ["-u", String(uid), "-f", sessionProcs.join("|")],
      { encoding: "utf8", timeout: 2000 }
    ).trim().split("\n").filter(Boolean);

    for (const pid of pids) {
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
        if (isFull()) break;
      } catch { /* unreadable — skip */ }
    }
  } catch { /* pgrep missing or no matches — not fatal */ }

  // ── Source 2: systemctl --user show-environment ───────────────────────────
  if (!needed.DBUS_SESSION_BUS_ADDRESS && isCommandAvailable("systemctl")) {
    try {
      const out = execSync("systemctl --user show-environment 2>/dev/null", {
        encoding: "utf8",
        timeout: 2000,
      });
      for (const line of out.split("\n").filter(Boolean)) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
        if (k in needed && !needed[k]) needed[k] = v;
      }
    } catch { /* systemctl not available or user session not running */ }
  }

  // ── Hardened fallbacks ────────────────────────────────────────────────────
  if (!needed.DISPLAY && !needed.WAYLAND_DISPLAY) needed.DISPLAY = ":0";
  if (!needed.XDG_RUNTIME_DIR && process.getuid) {
    needed.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }

  _resolvedEnvCache = needed;
  return needed;
}

/**
 * Validate whether the X11 DISPLAY is actually reachable.
 * Uses `xdpyinfo` with a tight 1-second timeout.
 * Returns true when reachable or when xdpyinfo is not installed
 * (we can't know for sure, so we give benefit of the doubt).
 */
function isDisplayReachable(display: string): boolean {
  if (!display || !isCommandAvailable("xdpyinfo")) return true; // assume OK
  try {
    execSync(`xdpyinfo -display ${display}`, { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

// ============ SANITISATION & TRUNCATION ============

function sanitize(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function prepTitle(t: string): string { return truncate(sanitize(t), MAX_TITLE_LEN); }
function prepBody(t: string): string { return truncate(sanitize(t), MAX_BODY_LEN); }

// ============ NOTIFY-SEND VERSION DETECTION ============

type NotifySendVersion = "v1" | "v2" | "unknown";
let _notifySendVersion: NotifySendVersion | null = null;

function getNotifySendVersion(): NotifySendVersion {
  if (_notifySendVersion) return _notifySendVersion;
  try {
    const out = execSync("notify-send --version 2>&1", { encoding: "utf8", timeout: 2000 });
    // v2.x (libnotify >= 0.8) prints "notify-send 0.8.x"
    const match = out.match(/(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      _notifySendVersion = (major > 0 || minor >= 8) ? "v2" : "v1";
    } else {
      _notifySendVersion = "unknown";
    }
  } catch {
    _notifySendVersion = "unknown";
  }
  return _notifySendVersion;
}

/** Build the expire-time argument for notify-send, handling v1/v2 differences. */
function notifySendTimeoutArgs(timeoutSec: number): string[] {
  const ms = String(timeoutSec * 1000);
  const ver = getNotifySendVersion();
  // v2 uses --expire-time; v1 uses -t (both accept ms)
  return ver === "v2" ? ["--expire-time", ms] : ["-t", ms];
}

// ============ COMMAND RUNNER ============

/**
 * Build the kdialog environment:
 * - Wayland: QT_QPA_PLATFORM=wayland (when WAYLAND_DISPLAY is present)
 * - X11:     QT_QPA_PLATFORM=xcb  (with DISPLAY validity check; clears if dead)
 */
function buildKdialogEnv(): Record<string, string> {
  const session = { ...resolveSessionEnv() };

  if (session.WAYLAND_DISPLAY) {
    return { ...session, QT_QPA_PLATFORM: "wayland" };
  }

  // Validate X11 display; clear it if the server is unreachable so
  // downstream code can decide to try Wayland or dbus-launch instead.
  if (session.DISPLAY && !isDisplayReachable(session.DISPLAY)) {
    process.stderr.write(
      `[linux-system-mcp] DISPLAY=${session.DISPLAY} is unreachable — clearing for this session.\n`
    );
    session.DISPLAY = "";
    _resolvedEnvCache = { ..._resolvedEnvCache!, DISPLAY: "" };
  }

  return { ...session, QT_QPA_PLATFORM: "xcb" };
}

/** Build env for zenity — same as session env but adds GDK_BACKEND=x11 on Wayland. */
function buildZenityEnv(): Record<string, string> {
  const session = resolveSessionEnv();
  // zenity uses GTK; on Wayland it needs GDK_BACKEND=x11 to fall back to XWayland.
  if (session.WAYLAND_DISPLAY) {
    return { ...session, GDK_BACKEND: "x11" };
  }
  return session;
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
    proc.stderr.on("data", () => { /* swallow */ });

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
        resolve({ stdout: "", exitCode: 127 });
      }
    });
  });
}

/**
 * Spawn a command detached so it outlives the parent call.
 * Used for passive notifications that should not block the caller.
 * Returns a promise that resolves almost immediately after spawn succeeds.
 */
function spawnDetached(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    let resolved = false;
    let proc: ReturnType<typeof spawn>;

    try {
      proc = spawn(cmd, args, {
        stdio: "ignore",
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0", ...extraEnv },
        detached: true,
      });
      proc.unref(); // let node exit without waiting for this process
    } catch {
      resolve({ exitCode: 127 });
      return;
    }

    // Give it 300 ms to see if it immediately crashes (e.g. command not found),
    // then return success — we don't wait for the popup to close.
    const earlyExit = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ exitCode: 0 }); }
    }, 300);

    proc.on("error", () => {
      if (!resolved) { resolved = true; clearTimeout(earlyExit); resolve({ exitCode: 127 }); }
    });

    proc.on("close", (code) => {
      // If it closed within 300 ms, it almost certainly crashed
      if (!resolved) {
        resolved = true;
        clearTimeout(earlyExit);
        resolve({ exitCode: code ?? 1 });
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

function isCrashExit(code: number): boolean {
  return code >= 128 || code === 127;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ============ DIALOG CONCURRENCY MUTEX ============

/**
 * Ensures interactive dialogs (confirm / alert / choice / input) are shown
 * one at a time.  Passive notifications are exempt — they don't block the user.
 */
let _dialogLock: Promise<void> = Promise.resolve();

function withDialogLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _dialogLock.then(() => fn());
  // Let the lock chain continue even if this dialog throws
  _dialogLock = next.then(() => { }, () => { });
  return next;
}

// ============ KDIALOG CRASH TRACKING / AUTO-DOWNGRADE ============

let kdialogCrashCount = 0;

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
    dialogManager = null; // force singleton rebuild with new backend
  }
}

function recordKdialogSuccess(): void {
  if (kdialogCrashCount > 0) kdialogCrashCount = 0;
}

// ============ KDIALOG IMPLEMENTATION ============

async function runKdialog(
  args: string[],
  timeoutMs?: number
): Promise<{ stdout: string; exitCode: number }> {
  const env = buildKdialogEnv();

  // Wrap with dbus-launch if the session bus is still missing
  if (!env.DBUS_SESSION_BUS_ADDRESS && isCommandAvailable("dbus-launch")) {
    return runCommand("dbus-launch", ["--exit-with-session", "kdialog", ...args], timeoutMs, env);
  }
  return runCommand("kdialog", args, timeoutMs, env);
}

/**
 * Passive popup — fire-and-forget.
 * Returns as soon as the process successfully spawns (does NOT wait for
 * the timeout to elapse), so the MCP call completes immediately.
 * Falls back through notify-send → dbus-send → stderr on crash.
 */
async function kdialogNotify(options: NotifyOptions): Promise<string> {
  // Rate-limit: drop exact duplicates within NOTIFY_DEDUP_WINDOW_MS
  if (isDuplicateNotify(options.title, options.message)) return "dedup";

  const timeout = options.timeout ?? 5;
  const body = prepBody(`${prepTitle(options.title)}\n\n${prepBody(options.message)}`);
  const args = ["--passivepopup", body, String(timeout)];
  const env = buildKdialogEnv();

  let spawnArgs = args;
  let spawnCmd = "kdialog";

  if (!env.DBUS_SESSION_BUS_ADDRESS && isCommandAvailable("dbus-launch")) {
    spawnCmd = "dbus-launch";
    spawnArgs = ["--exit-with-session", "kdialog", ...args];
  }

  const result = await spawnDetached(spawnCmd, spawnArgs, env);

  if (result.exitCode === 0) {
    recordKdialogSuccess();
    return "kdialog";
  }

  if (isCrashExit(result.exitCode)) recordKdialogCrash();
  return notifySendNotify(options, true);
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
      if (isCommandAvailable("xmessage")) return xmessageConfirm(options);
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
      if (isCommandAvailable("xmessage")) return xmessageAlert(options);
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

// ============ PASSWORD INPUT IMPLEMENTATIONS ============

/**
 * kdialog --password shows a masked text input (platform-native password dialog).
 * The password is read from stdout and never written to any log.
 */
async function kdialogPassword(options: PasswordOptions): Promise<PasswordResult> {
  const args = [
    "--title", prepTitle(options.title),
    "--password", prepBody(options.message),
  ];
  let result = await runKdialog(args);

  if (isCrashExit(result.exitCode)) {
    recordKdialogCrash();
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      recordKdialogCrash();
      throw new Error(`kdialog crashed showing password dialog (exit ${result.exitCode}).`);
    }
  }

  if (result.exitCode !== 0) return { password: "", cancelled: true };
  recordKdialogSuccess();
  return { password: result.stdout, cancelled: false };
}

async function zenityPassword(options: PasswordOptions): Promise<PasswordResult> {
  const args = [
    "--password",
    "--title", prepTitle(options.title),
  ];
  // zenity --password doesn't support a custom prompt text, so prepend to title
  const result = await runCommand("zenity", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0) return { password: "", cancelled: true };
  return { password: result.stdout, cancelled: false };
}

// ============ XMESSAGE FALLBACK (pure X11, no Qt/GTK) ============

async function xmessageConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const text = `${prepTitle(options.title)}\n\n${prepBody(options.message)}`;
  const result = await runCommand(
    "xmessage",
    ["-buttons", "Yes:0,No:1", "-default", "No", text],
    60000, resolveSessionEnv()
  );
  return { confirmed: result.exitCode === 0 };
}

async function xmessageAlert(options: AlertOptions): Promise<AlertResult> {
  const text = `${prepTitle(options.title)}\n\n${prepBody(options.message)}`;
  const result = await runCommand(
    "xmessage",
    ["-buttons", "OK:0", "-default", "OK", text],
    60000, resolveSessionEnv()
  );
  return { acknowledged: result.exitCode === 0 };
}

// ============ ZENITY IMPLEMENTATION ============

async function zenityNotify(options: NotifyOptions): Promise<string> {
  if (isCommandAvailable("notify-send")) {
    return notifySendNotify(options);
  }
  const env = buildZenityEnv();
  const result = await runCommand(
    "zenity",
    ["--notification", "--text", prepBody(`${prepTitle(options.title)}\n${prepBody(options.message)}`)],
    8000, env
  );
  if (result.exitCode !== 0) return dbusNotify(options, true);
  return "zenity";
}

async function zenityConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const result = await runCommand(
    "zenity",
    ["--question", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildZenityEnv()
  );
  if (isCrashExit(result.exitCode) && isCommandAvailable("xmessage")) {
    return xmessageConfirm(options);
  }
  return { confirmed: result.exitCode === 0 };
}

async function zenityAlert(options: AlertOptions): Promise<AlertResult> {
  const result = await runCommand(
    "zenity",
    ["--info", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildZenityEnv()
  );
  if (isCrashExit(result.exitCode) && isCommandAvailable("xmessage")) {
    return xmessageAlert(options);
  }
  return { acknowledged: result.exitCode === 0 };
}

async function zenityChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true };

  const args = [
    "--list", "--radiolist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c, i) => args.push(i === 0 ? "TRUE" : "FALSE", prepBody(c)));

  const result = await runCommand("zenity", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: null, index: -1, cancelled: true };

  const selected = result.stdout;
  const index = options.choices.indexOf(selected);
  return { selected: index !== -1 ? selected : null, index, cancelled: false };
}

async function zenityInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--entry",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--width", "400",
  ];
  if (options.defaultValue) args.push("--entry-text", prepBody(options.defaultValue));

  const result = await runCommand("zenity", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0) return { input: "", cancelled: true };
  return { input: result.stdout, cancelled: false };
}

// ============ NOTIFY-SEND IMPLEMENTATION ============

/** Returns the delivery method string, or chains to dbus-send on failure. */
async function notifySendNotify(options: NotifyOptions, isFallback = false): Promise<string> {
  if (!isCommandAvailable("notify-send")) {
    return dbusNotify(options, isFallback);
  }

  const urgencyMap: Record<Urgency, string> = { low: "low", normal: "normal", critical: "critical" };
  const args = [
    "-u", urgencyMap[options.urgency || "normal"],
    ...notifySendTimeoutArgs(options.timeout ?? 5),
    prepTitle(options.title),
    prepBody(options.message),
  ];

  const result = await runCommand("notify-send", args, 5000, resolveSessionEnv());
  if (result.exitCode !== 0) return dbusNotify(options, true);
  return "notify-send";
}

// ============ DBUS-SEND NATIVE NOTIFICATION ============

async function dbusNotify(options: NotifyOptions, _isFallback = false): Promise<string> {
  if (!isCommandAvailable("dbus-send")) {
    logFallback("dbus-send (not installed)", options);
    return "stderr";
  }

  const env = resolveSessionEnv();
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    logFallback("dbus-send (no DBUS_SESSION_BUS_ADDRESS)", options);
    return "stderr";
  }

  const urgencyMap: Record<Urgency, number> = { low: 0, normal: 1, critical: 2 };
  const timeoutMs = (options.timeout ?? 5) * 1000;

  const args = [
    "--session",
    "--dest=org.freedesktop.Notifications",
    "--type=method_call",
    "/org/freedesktop/Notifications",
    "org.freedesktop.Notifications.Notify",
    `string:linux-system-mcp`,
    `uint32:0`,
    `string:`,
    `string:${prepTitle(options.title)}`,
    `string:${prepBody(options.message)}`,
    `array:string:`,
    `dict:string:variant:,byte:urgency,byte:${urgencyMap[options.urgency || "normal"]}`,
    `int32:${timeoutMs}`,
  ];

  const result = await runCommand("dbus-send", args, 5000, env);
  if (result.exitCode !== 0) {
    logFallback("dbus-send", options);
    return "stderr";
  }
  return "dbus-send";
}

// ============ SHARED UTILITIES ============

function logFallback(failedBackend: string, options: NotifyOptions | AlertOptions): void {
  const msg = "message" in options ? options.message : "";
  process.stderr.write(
    `[linux-system-mcp] NOTIFICATION (${failedBackend} failed) — ${options.title}: ${msg}\n`
  );
}

// ============ EFFECTIVE BACKEND RESOLUTION ============

function resolveEffectiveBackend(
  detectedBackend: DialogBackend,
  available: { kdialog: boolean; zenity: boolean; notifySend: boolean }
): { backend: DialogBackend; supportsDialogs: boolean } {
  if (detectedBackend === "kdialog" && isKdialogBlacklisted()) {
    if (available.zenity) return { backend: "zenity", supportsDialogs: true };
    if (available.notifySend) return { backend: "notify-send-only", supportsDialogs: false };
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

  getBackend(): DialogBackend {
    return resolveEffectiveBackend(this._detectedBackend, this._available).backend;
  }

  canShowDialogs(): boolean {
    return resolveEffectiveBackend(this._detectedBackend, this._available).supportsDialogs;
  }

  canNotify(): boolean {
    return (
      isCommandAvailable("kdialog") ||
      isCommandAvailable("notify-send") ||
      isCommandAvailable("zenity") ||
      isCommandAvailable("dbus-send")
    );
  }

  /**
   * Send a desktop notification.
   * Returns immediately after spawn (fire-and-forget for passive popups).
   * Resolves with the backend that actually delivered it.
   */
  async notify(options: NotifyOptions): Promise<string> {
    const { backend } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (backend === "kdialog") return kdialogNotify(options);
    if (backend === "zenity") return zenityNotify(options);
    return notifySendNotify(options);
  }

  /** Show an OK-only message box. Interactive — goes through the concurrency mutex. */
  async alert(options: AlertOptions): Promise<AlertResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      await this.notify({ title: options.title, message: options.message }).catch(() => { });
      return { acknowledged: false };
    }
    return withDialogLock(() =>
      backend === "kdialog" ? kdialogAlert(options) : zenityAlert(options)
    );
  }

  async confirm(options: ConfirmOptions): Promise<ConfirmResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. " +
        "Install: sudo pacman -S kdialog  (KDE)  or  sudo pacman -S zenity"
      );
    }
    return withDialogLock(() =>
      backend === "kdialog" ? kdialogConfirm(options) : zenityConfirm(options)
    );
  }

  async choice(options: ChoiceOptions): Promise<ChoiceResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. " +
        "Install: sudo pacman -S kdialog  (KDE)  or  sudo pacman -S zenity"
      );
    }
    if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true };
    return withDialogLock(() =>
      backend === "kdialog" ? kdialogChoice(options) : zenityChoice(options)
    );
  }

  async input(options: InputOptions): Promise<InputResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      throw new Error(
        "Dialog support requires kdialog or zenity. " +
        "Install: sudo pacman -S kdialog  (KDE)  or  sudo pacman -S zenity"
      );
    }
    return withDialogLock(() =>
      backend === "kdialog" ? kdialogInput(options) : zenityInput(options)
    );
  }

  /**
   * Show a masked password input dialog.
   * The result is never logged; callers should treat it as a secret.
   */
  async password(options: PasswordOptions): Promise<PasswordResult> {
    const { backend, supportsDialogs } = resolveEffectiveBackend(this._detectedBackend, this._available);
    if (!supportsDialogs) {
      throw new Error(
        "Password dialog requires kdialog or zenity. " +
        "Install: sudo pacman -S kdialog  (KDE)  or  sudo pacman -S zenity"
      );
    }
    return withDialogLock(() =>
      backend === "kdialog" ? kdialogPassword(options) : zenityPassword(options)
    );
  }
}

// Singleton — nulled when kdialog is blacklisted to force backend re-resolution.
let dialogManager: DialogManager | null = null;

export function getDialogManager(): DialogManager {
  if (!dialogManager) dialogManager = new DialogManager();
  return dialogManager;
}
