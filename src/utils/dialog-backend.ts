import { spawn, spawnSync, execSync, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { getDialogBackend, DialogBackend } from "./de-detect.js";
import {
  isTkinterAvailable,
  tkinterConfirm,
  tkinterAlert,
  tkinterChoice,
  tkinterMultiCheck,
  tkinterInput,
  tkinterPassword,
} from "./native-tkinter-dialog.js";

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

export interface MultiCheckOptions {
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
  backend: string;
  failed?: string;
}

export interface AlertResult {
  acknowledged: boolean;
  backend: string;
  notAvailable?: string[];
  failed?: string;
}

export interface ChoiceResult {
  selected: string | null;
  index: number;
  cancelled: boolean;
  backend: string;
  failed?: string;
}

export interface MultiCheckResult {
  selected: string[];
  indices: number[];
  cancelled: boolean;
  backend: string;
  failed?: string;
}

export interface InputResult {
  input: string;
  cancelled: boolean;
  backend: string;
  failed?: string;
}

export interface PasswordOptions {
  title: string;
  message: string;
}

export interface PasswordResult {
  password: string;
  cancelled: boolean;
  backend: string;
  failed?: string;
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

function isDuplicateNotify(title: string, message: string, urgency: string): boolean {
  // Include urgency in the key so a critical re-alert isn't suppressed
  const key = `${urgency}\x00${title}\x00${message}`;
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

/** Caches `which <cmd>` results with a 30 s TTL to balance performance with
 *  correctness (e.g. binary installed after server starts). */
const _cmdAvailCache = new Map<string, { result: boolean; ts: number }>();
const CMD_AVAIL_TTL_MS = 30_000;

function isCommandAvailable(cmd: string): boolean {
  const cached = _cmdAvailCache.get(cmd);
  const now = Date.now();
  if (cached && now - cached.ts < CMD_AVAIL_TTL_MS) return cached.result;
  try {
    // spawnSync prevents shell injection if 'cmd' ever becomes user-controlled
    const { status, error } = spawnSync("which", [cmd], { stdio: "ignore", timeout: 2000 });
    const result = !error && status === 0;
    _cmdAvailCache.set(cmd, { result, ts: now });
    return result;
  } catch {
    _cmdAvailCache.set(cmd, { result: false, ts: now });
    return false;
  }
}

// ============ ENVIRONMENT RESOLUTION ============

/** Cached resolved session env — populated on first call. */
let _resolvedEnvCache: Record<string, string> | null = null;
/** Timestamp of last cache population — used for 30 s TTL re-scan. */
let _resolvedEnvCacheTime = 0;
const RESOLVE_ENV_TTL_MS = 30_000;

/**
 * When the MCP server is spawned from a browser/Chromium scope the process
 * environment often lacks DISPLAY, DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY
 * etc.  This function recovers those values by:
 *  1. Scanning /proc/<pid>/environ of the user's own session processes
 *  2. Querying `systemctl --user show-environment` (reliable on systemd desktops)
 *  3. Applying safe hardcoded last-resort defaults
 * Result is cached for RESOLVE_ENV_TTL_MS ms so re-login scenarios work.
 */
export function resolveSessionEnv(): Record<string, string> {
  const now = Date.now();
  if (_resolvedEnvCache && now - _resolvedEnvCacheTime < RESOLVE_ENV_TTL_MS) return _resolvedEnvCache;

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
          // Only accept if it doesn't contain obvious shell injection hazards
          // (since these might get passed to execSync like `xdpyinfo -display $DISPLAY`)
          if (k in needed && !needed[k] && !v.includes("`") && !v.includes("$(")) {
            needed[k] = v;
          }
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

  // ── Source 3: systemd user bus socket (always present on systemd desktops) ──
  if (!needed.DBUS_SESSION_BUS_ADDRESS) {
    const uid = process.getuid?.() ?? -1;
    if (uid !== -1) {
      const socketPath = `/run/user/${uid}/bus`;
      if (existsSync(socketPath)) {
        needed.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socketPath}`;
      }
    }
  }

  // ── Hardened fallbacks ────────────────────────────────────────────────────
  if (needed.WAYLAND_DISPLAY && needed.WAYLAND_DISPLAY.includes("/")) {
    needed.WAYLAND_DISPLAY = basename(needed.WAYLAND_DISPLAY);
  }
  if (!needed.WAYLAND_DISPLAY && needed.XDG_RUNTIME_DIR) {
    const waylandSocket = join(needed.XDG_RUNTIME_DIR, "wayland-0");
    if (existsSync(waylandSocket)) {
      needed.WAYLAND_DISPLAY = "wayland-0";
    }
  }
  if (!needed.XAUTHORITY) {
    const defaultAuth = join(homedir(), ".Xauthority");
    if (existsSync(defaultAuth)) {
      needed.XAUTHORITY = defaultAuth;
    }
  }

  if (!needed.DISPLAY && !needed.WAYLAND_DISPLAY) needed.DISPLAY = ":0";
  if (!needed.XDG_RUNTIME_DIR && process.getuid) {
    needed.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }

  _resolvedEnvCache = needed;
  _resolvedEnvCacheTime = Date.now();
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
    // spawnSync prevents shell injection via malicious DISPLAY value (e.g. from /proc)
    const { status, error } = spawnSync("xdpyinfo", ["-display", display], { stdio: "ignore", timeout: 1000 });
    return !error && status === 0;
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
  extraEnv: Record<string, string> = {},
  trimOutput = true  // set false for password dialogs to preserve trailing whitespace
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
        resolve({ stdout: trimOutput ? stdout.trim() : stdout, exitCode: 124 });
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
        resolve({ stdout: trimOutput ? stdout.trim() : stdout, exitCode });
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

/** Returns true when the exit code indicates a signal-caused crash or spawn error. */
function isCrashExit(code: number): boolean {
  return code >= 128 || code === 127;
}

/** Returns true when the process was killed by our own timeout sentinel (exit 124). */
function isTimeoutExit(code: number): boolean {
  return code === 124;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ============ DIALOG CONCURRENCY MUTEX ============

/**
 * Ensures interactive dialogs (confirm / alert / choice / input) are shown
 * one at a time.  Passive notifications are exempt — they don't block the user.
 * Queue is capped at MAX_DIALOG_QUEUE to prevent unbounded accumulation.
 */
let _dialogLock: Promise<void> = Promise.resolve();
let _dialogQueueDepth = 0;
const MAX_DIALOG_QUEUE = 5;

function withDialogLock<T>(fn: () => Promise<T>): Promise<T> {
  if (_dialogQueueDepth >= MAX_DIALOG_QUEUE) {
    return Promise.reject(
      new Error(
        `Dialog queue full (${MAX_DIALOG_QUEUE} dialogs already pending). ` +
        `Please wait for the current dialogs to be answered.`
      )
    );
  }
  _dialogQueueDepth++;
  const next = _dialogLock.then(() => fn());
  // Release lock and decrement depth when the dialog settles
  _dialogLock = next.then(() => { _dialogQueueDepth--; }, () => { _dialogQueueDepth--; });
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
  timeoutMs?: number,
  trimOutput = true
): Promise<{ stdout: string; exitCode: number }> {
  const env = buildKdialogEnv();

  // Wrap with dbus-launch if the session bus is still missing
  if (!env.DBUS_SESSION_BUS_ADDRESS && isCommandAvailable("dbus-launch")) {
    return runCommand("dbus-launch", ["--exit-with-session", "kdialog", ...args], timeoutMs, env, trimOutput);
  }
  return runCommand("kdialog", args, timeoutMs, env, trimOutput);
}

/**
 * Passive popup — fire-and-forget.
 * Returns as soon as the process successfully spawns (does NOT wait for
 * the timeout to elapse), so the MCP call completes immediately.
 * Falls back through notify-send → dbus-send → stderr on crash.
 */
async function kdialogNotify(options: NotifyOptions): Promise<string> {
  // Note: dedup is handled at DialogManager.notify() level — not repeated here

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
  return { confirmed: result.exitCode === 0, backend: "kdialog" };
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
      return { acknowledged: false, backend: "kdialog" };
    }
  }

  if (result.exitCode === 0) recordKdialogSuccess();
  return { acknowledged: result.exitCode === 0, backend: "kdialog" };
}

async function kdialogChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true, backend: "kdialog" };

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

  if (result.exitCode !== 0) return { selected: null, index: -1, cancelled: true, backend: "kdialog" };

  recordKdialogSuccess();
  const idx = parseInt(result.stdout, 10);
  if (isNaN(idx) || idx < 0 || idx >= options.choices.length) {
    return { selected: null, index: -1, cancelled: true, backend: "kdialog" };
  }
  return { selected: options.choices[idx], index: idx, cancelled: false, backend: "kdialog" };
}

async function kdialogMultiCheck(options: MultiCheckOptions): Promise<MultiCheckResult> {
  if (options.choices.length === 0) return { selected: [], indices: [], cancelled: true, backend: "kdialog" };

  const args = ["--title", prepTitle(options.title), "--checklist", prepBody(options.message)];
  options.choices.forEach((c, i) => args.push(String(i), prepBody(c), "off"));

  let result = await runKdialog(args);

  if (isCrashExit(result.exitCode)) {
    recordKdialogCrash();
    await sleep(150);
    result = await runKdialog(args);
    if (isCrashExit(result.exitCode)) {
      recordKdialogCrash();
      throw new Error(`kdialog crashed showing checklist dialog (exit ${result.exitCode}).`);
    }
  }

  if (result.exitCode !== 0) return { selected: [], indices: [], cancelled: true, backend: "kdialog" };

  recordKdialogSuccess();
  const selectedValues = result.stdout.replace(/"/g, "").split(" ").filter(Boolean);
  const selected: string[] = [];
  const indices: number[] = [];
  for (const value of selectedValues) {
    const idx = parseInt(value, 10);
    if (!isNaN(idx) && idx >= 0 && idx < options.choices.length) {
      selected.push(options.choices[idx]);
      indices.push(idx);
    }
  }
  return { selected, indices, cancelled: false, backend: "kdialog" };
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

  if (result.exitCode !== 0) return { input: "", cancelled: true, backend: "kdialog" };

  recordKdialogSuccess();
  return { input: result.stdout, cancelled: false, backend: "kdialog" };
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
  let result = await runKdialog(args, undefined, false);

  if (isCrashExit(result.exitCode)) {
    recordKdialogCrash();
    await sleep(150);
    result = await runKdialog(args, undefined, false);
    if (isCrashExit(result.exitCode)) {
      recordKdialogCrash();
      throw new Error(`kdialog crashed showing password dialog (exit ${result.exitCode}).`);
    }
  }

  if (result.exitCode !== 0) return { password: "", cancelled: true, backend: "kdialog" };
  recordKdialogSuccess();
  return { password: result.stdout.replace(/\n$/, ""), cancelled: false, backend: "kdialog" };
}

async function zenityPassword(options: PasswordOptions): Promise<PasswordResult> {
  const args = [
    "--password",
    "--title", prepTitle(options.title),
  ];
  const result = await runCommand("zenity", args, 60000, buildZenityEnv(), false);
  if (result.exitCode !== 0) return { password: "", cancelled: true, backend: "zenity" };
  return { password: result.stdout.replace(/\n$/, ""), cancelled: false, backend: "zenity" };
}

// ============ XMESSAGE FALLBACK (pure X11, no Qt/GTK) ============

async function xmessageConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const text = `${prepTitle(options.title)}\n\n${prepBody(options.message)}`;
  const result = await runCommand(
    "xmessage",
    ["-buttons", "Yes:0,No:1", "-default", "No", text],
    60000, resolveSessionEnv()
  );
  return { confirmed: result.exitCode === 0, backend: "xmessage" };
}

async function xmessageAlert(options: AlertOptions): Promise<AlertResult> {
  const text = `${prepTitle(options.title)}\n\n${prepBody(options.message)}`;
  const result = await runCommand(
    "xmessage",
    ["-buttons", "OK:0", "-default", "OK", text],
    60000, resolveSessionEnv()
  );
  return { acknowledged: result.exitCode === 0, backend: "xmessage" };
}

// ============ ZENITY IMPLEMENTATION ============

async function zenityNotify(options: NotifyOptions): Promise<string> {
  if (isCommandAvailable("notify-send")) {
    return notifySendNotify(options);
  }
  // Fire-and-forget via spawnDetached — don't block caller for notification duration.
  const env = buildZenityEnv();
  const result = await spawnDetached(
    "zenity",
    ["--notification", "--text", prepBody(`${prepTitle(options.title)}\n${prepBody(options.message)}`)],
    env
  );
  // Timeout exits on spawnDetached just mean it outlived the 300ms window — success.
  if (result.exitCode !== 0 && !isTimeoutExit(result.exitCode)) return dbusNotify(options, true);
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
  return { confirmed: result.exitCode === 0, backend: "zenity" };
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
  return { acknowledged: result.exitCode === 0, backend: "zenity" };
}

async function zenityChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true, backend: "zenity" };

  const args = [
    "--list", "--radiolist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c, i) => args.push(i === 0 ? "TRUE" : "FALSE", prepBody(c)));

  const result = await runCommand("zenity", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: null, index: -1, cancelled: true, backend: "zenity" };

  const selected = result.stdout;
  const index = options.choices.indexOf(selected);
  return { selected: index !== -1 ? selected : null, index, cancelled: false, backend: "zenity" };
}

async function zenityMultiCheck(options: MultiCheckOptions): Promise<MultiCheckResult> {
  if (options.choices.length === 0) return { selected: [], indices: [], cancelled: true, backend: "zenity" };

  const args = [
    "--list", "--checklist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c) => args.push("FALSE", prepBody(c)));

  const result = await runCommand("zenity", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: [], indices: [], cancelled: true, backend: "zenity" };

  const selectedItems = result.stdout.split("\n").filter(Boolean);
  const selected: string[] = [];
  const indices: number[] = [];
  for (const item of selectedItems) {
    const idx = options.choices.indexOf(item);
    if (idx !== -1) {
      selected.push(item);
      indices.push(idx);
    }
  }
  return { selected, indices, cancelled: false, backend: "zenity" };
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
  if (result.exitCode !== 0) return { input: "", cancelled: true, backend: "zenity" };
  return { input: result.stdout, cancelled: false, backend: "zenity" };
}

// ============ YAD IMPLEMENTATION ============

function buildYadEnv(): Record<string, string> {
  const session = resolveSessionEnv();
  if (session.WAYLAND_DISPLAY) {
    return { ...session, GDK_BACKEND: "x11" };
  }
  return session;
}

async function yadConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const result = await runCommand(
    "yad",
    ["--question", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildYadEnv()
  );
  return { confirmed: result.exitCode === 0, backend: "yad" };
}

async function yadAlert(options: AlertOptions): Promise<AlertResult> {
  const result = await runCommand(
    "yad",
    ["--info", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildYadEnv()
  );
  return { acknowledged: result.exitCode === 0, backend: "yad" };
}

async function yadChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true, backend: "yad" };

  const args = [
    "--list", "--radiolist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c, i) => args.push(i === 0 ? "TRUE" : "FALSE", prepBody(c)));

  const result = await runCommand("yad", args, 60000, buildYadEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: null, index: -1, cancelled: true, backend: "yad" };

  const selected = result.stdout.trim();
  const index = options.choices.indexOf(selected);
  return { selected: index !== -1 ? selected : null, index, cancelled: false, backend: "yad" };
}

async function yadMultiCheck(options: MultiCheckOptions): Promise<MultiCheckResult> {
  if (options.choices.length === 0) return { selected: [], indices: [], cancelled: true, backend: "yad" };

  const args = [
    "--list", "--checklist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c) => args.push("FALSE", prepBody(c)));

  const result = await runCommand("yad", args, 60000, buildYadEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: [], indices: [], cancelled: true, backend: "yad" };

  const selectedItems = result.stdout.split("\n").filter(Boolean).map(s => s.trim());
  const selected: string[] = [];
  const indices: number[] = [];
  for (const item of selectedItems) {
    const idx = options.choices.indexOf(item);
    if (idx !== -1) {
      selected.push(item);
      indices.push(idx);
    }
  }
  return { selected, indices, cancelled: false, backend: "yad" };
}

async function yadInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--entry",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--width", "400",
  ];
  if (options.defaultValue) args.push("--entry-text", prepBody(options.defaultValue));

  const result = await runCommand("yad", args, 60000, buildYadEnv());
  if (result.exitCode !== 0) return { input: "", cancelled: true, backend: "yad" };
  return { input: result.stdout, cancelled: false, backend: "yad" };
}

async function yadPassword(options: PasswordOptions): Promise<PasswordResult> {
  const args = [
    "--entry",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--width", "400",
    "--hide-text",
  ];

  const result = await runCommand("yad", args, 60000, buildYadEnv(), false);
  if (result.exitCode !== 0) return { password: "", cancelled: true, backend: "yad" };
  return { password: result.stdout.replace(/\n$/, ""), cancelled: false, backend: "yad" };
}

// ============ MATEDIALOG IMPLEMENTATION ============

// matedialog uses same syntax as zenity
async function matedialogConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const result = await runCommand(
    "matedialog",
    ["--question", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildZenityEnv()
  );
  return { confirmed: result.exitCode === 0, backend: "matedialog" };
}

async function matedialogAlert(options: AlertOptions): Promise<AlertResult> {
  const result = await runCommand(
    "matedialog",
    ["--info", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildZenityEnv()
  );
  return { acknowledged: result.exitCode === 0, backend: "matedialog" };
}

async function matedialogChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true, backend: "matedialog" };

  const args = [
    "--list", "--radiolist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c, i) => args.push(i === 0 ? "TRUE" : "FALSE", prepBody(c)));

  const result = await runCommand("matedialog", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: null, index: -1, cancelled: true, backend: "matedialog" };

  const selected = result.stdout;
  const index = options.choices.indexOf(selected);
  return { selected: index !== -1 ? selected : null, index, cancelled: false, backend: "matedialog" };
}

async function matedialogMultiCheck(options: MultiCheckOptions): Promise<MultiCheckResult> {
  if (options.choices.length === 0) return { selected: [], indices: [], cancelled: true, backend: "matedialog" };

  const args = [
    "--list", "--checklist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c) => args.push("FALSE", prepBody(c)));

  const result = await runCommand("matedialog", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: [], indices: [], cancelled: true, backend: "matedialog" };

  const selectedItems = result.stdout.split("\n").filter(Boolean);
  const selected: string[] = [];
  const indices: number[] = [];
  for (const item of selectedItems) {
    const idx = options.choices.indexOf(item);
    if (idx !== -1) {
      selected.push(item);
      indices.push(idx);
    }
  }
  return { selected, indices, cancelled: false, backend: "matedialog" };
}

async function matedialogInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--entry",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--width", "400",
  ];
  if (options.defaultValue) args.push("--entry-text", prepBody(options.defaultValue));

  const result = await runCommand("matedialog", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0) return { input: "", cancelled: true, backend: "matedialog" };
  return { input: result.stdout, cancelled: false, backend: "matedialog" };
}

async function matedialogPassword(options: PasswordOptions): Promise<PasswordResult> {
  const args = ["--password", "--title", prepTitle(options.title)];
  const result = await runCommand("matedialog", args, 60000, buildZenityEnv(), false);
  if (result.exitCode !== 0) return { password: "", cancelled: true, backend: "matedialog" };
  return { password: result.stdout.replace(/\n$/, ""), cancelled: false, backend: "matedialog" };
}

// ============ QARMA IMPLEMENTATION ============

// qarma is a zenity clone for Qt, uses same syntax
async function qarmaConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const result = await runCommand(
    "qarma",
    ["--question", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildZenityEnv()
  );
  return { confirmed: result.exitCode === 0, backend: "qarma" };
}

async function qarmaAlert(options: AlertOptions): Promise<AlertResult> {
  const result = await runCommand(
    "qarma",
    ["--info", "--title", prepTitle(options.title), "--text", prepBody(options.message), "--width", "400"],
    60000, buildZenityEnv()
  );
  return { acknowledged: result.exitCode === 0, backend: "qarma" };
}

async function qarmaChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  if (options.choices.length === 0) return { selected: null, index: -1, cancelled: true, backend: "qarma" };

  const args = [
    "--list", "--radiolist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c, i) => args.push(i === 0 ? "TRUE" : "FALSE", prepBody(c)));

  const result = await runCommand("qarma", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: null, index: -1, cancelled: true, backend: "qarma" };

  const selected = result.stdout;
  const index = options.choices.indexOf(selected);
  return { selected: index !== -1 ? selected : null, index, cancelled: false, backend: "qarma" };
}

async function qarmaMultiCheck(options: MultiCheckOptions): Promise<MultiCheckResult> {
  if (options.choices.length === 0) return { selected: [], indices: [], cancelled: true, backend: "qarma" };

  const args = [
    "--list", "--checklist",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--column", "Select", "--column", "Option",
    "--width", "400", "--height", "300",
  ];
  options.choices.forEach((c) => args.push("FALSE", prepBody(c)));

  const result = await runCommand("qarma", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0 || !result.stdout) return { selected: [], indices: [], cancelled: true, backend: "qarma" };

  const selectedItems = result.stdout.split("\n").filter(Boolean);
  const selected: string[] = [];
  const indices: number[] = [];
  for (const item of selectedItems) {
    const idx = options.choices.indexOf(item);
    if (idx !== -1) {
      selected.push(item);
      indices.push(idx);
    }
  }
  return { selected, indices, cancelled: false, backend: "qarma" };
}

async function qarmaInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--entry",
    "--title", prepTitle(options.title),
    "--text", prepBody(options.message),
    "--width", "400",
  ];
  if (options.defaultValue) args.push("--entry-text", prepBody(options.defaultValue));

  const result = await runCommand("qarma", args, 60000, buildZenityEnv());
  if (result.exitCode !== 0) return { input: "", cancelled: true, backend: "qarma" };
  return { input: result.stdout, cancelled: false, backend: "qarma" };
}

async function qarmaPassword(options: PasswordOptions): Promise<PasswordResult> {
  const args = ["--password", "--title", prepTitle(options.title)];
  const result = await runCommand("qarma", args, 60000, buildZenityEnv(), false);
  if (result.exitCode !== 0) return { password: "", cancelled: true, backend: "qarma" };
  return { password: result.stdout.replace(/\n$/, ""), cancelled: false, backend: "qarma" };
}

// ============ NOTIFY-SEND IMPLEMENTATION ============

/** Returns the delivery method string, or chains to dbus-send on failure. */
async function notifySendNotify(options: NotifyOptions, isFallback = false): Promise<string> {
  if (!isCommandAvailable("notify-send")) {
    return dbusNotify(options, isFallback);
  }

  const ver = getNotifySendVersion();
  const urgencyMap: Record<Urgency, string> = { low: "low", normal: "normal", critical: "critical" };
  const args: string[] = [
    "-u", urgencyMap[options.urgency || "normal"],
    ...notifySendTimeoutArgs(options.timeout ?? 5),
  ];
  // --app-name is a v2 flag; skip it on v1 to avoid "invalid option" errors
  if (ver === "v2") args.push("--app-name", "linux-system-mcp");
  args.push(prepTitle(options.title), prepBody(options.message));

  // notify-send exits quickly after handing off to the notification daemon,
  // so a short foreground spawn is more reliable than detached mode here.
  const result = await runCommand("notify-send", args, 1500, resolveSessionEnv());
  if (result.exitCode !== 0 && !isTimeoutExit(result.exitCode)) return dbusNotify(options, true);
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
    `string:dialog-information`,          // app_icon
    `string:${prepTitle(options.title)}`,
    `string:${prepBody(options.message)}`,
    `array:string:`,
    `dict:string:variant:,byte:urgency,byte:${urgencyMap[options.urgency || "normal"]}`,
    `int32:${timeoutMs}`,
  ];

  // dbus-send returns after the daemon ACKs, so a short foreground spawn is enough.
  const result = await runCommand("dbus-send", args, 1500, env);
  if (result.exitCode !== 0 && !isTimeoutExit(result.exitCode)) {
    logFallback("dbus-send", options);
    return "stderr";
  }
  return "dbus-send";
}

// ============ SHARED UTILITIES ============

function logFallback(failedBackend: string, options: NotifyOptions | AlertOptions, errors?: string[]): void {
  const msg = "message" in options ? options.message : "";
  let logMsg = `[linux-system-mcp] NOTIFICATION (${failedBackend} failed) — ${options.title}: ${msg}`;
  if (errors && errors.length > 0) {
    logMsg += ` | Errors: ${errors.join("; ")}`;
  }
  process.stderr.write(logMsg + "\n");
}

// ============ EFFECTIVE BACKEND RESOLUTION ============

function resolveEffectiveBackend(
  detectedBackend: DialogBackend,
  available: { kdialog: boolean; zenity: boolean; notifySend: boolean }
): { backend: DialogBackend; supportsDialogs: boolean } {
  // "none" means absolutely nothing is installed — dialogs and notifications both unsupported
  if (detectedBackend === "none" as DialogBackend) {
    return { backend: "none" as DialogBackend, supportsDialogs: false };
  }
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

export type DialogBackendName = "kdialog" | "yad" | "matedialog" | "qarma" | "zenity";

export interface BackendInfo {
  name: DialogBackendName;
  available: boolean;
}

interface BackendStats {
  success: number;
  failures: number;
  lastFailure: number;
  consecutiveFailures: number;
}

const HEALTH_RESET_TIMEOUT_MS = 60_000; // 1 minute - reset failure count after this
const MAX_CONSECUTIVE_FAILURES = 3; // Blacklist after this many consecutive failures

export class DialogManager {
  private _availableDialogBackends: DialogBackendName[];
  private _availableNotifyBackends: string[];
  private _blacklistedDialogBackend: DialogBackendName | null = null;
  private _dialogStats: Map<DialogBackendName, BackendStats> = new Map();
  private _notifyStats: Map<string, BackendStats> = new Map();

  constructor() {
    // Detect and store available dialog backends at startup
    // Priority order: kdialog > yad > matedialog > qarma > zenity
    this._availableDialogBackends = [];
    
    if (isCommandAvailable("kdialog")) {
      this._availableDialogBackends.push("kdialog");
      this._dialogStats.set("kdialog", { success: 0, failures: 0, lastFailure: 0, consecutiveFailures: 0 });
    }
    if (isCommandAvailable("yad")) {
      this._availableDialogBackends.push("yad");
      this._dialogStats.set("yad", { success: 0, failures: 0, lastFailure: 0, consecutiveFailures: 0 });
    }
    if (isCommandAvailable("matedialog")) {
      this._availableDialogBackends.push("matedialog");
      this._dialogStats.set("matedialog", { success: 0, failures: 0, lastFailure: 0, consecutiveFailures: 0 });
    }
    if (isCommandAvailable("qarma")) {
      this._availableDialogBackends.push("qarma");
      this._dialogStats.set("qarma", { success: 0, failures: 0, lastFailure: 0, consecutiveFailures: 0 });
    }
    if (isCommandAvailable("zenity")) {
      this._availableDialogBackends.push("zenity");
      this._dialogStats.set("zenity", { success: 0, failures: 0, lastFailure: 0, consecutiveFailures: 0 });
    }

    // Detect and store available notification backends at startup
    this._availableNotifyBackends = [];
    const notifyBackends = ["notify-send", "kdialog", "zenity", "dbus-send"];
    for (const backend of notifyBackends) {
      if (isCommandAvailable(backend)) {
        this._availableNotifyBackends.push(backend);
        this._notifyStats.set(backend, { success: 0, failures: 0, lastFailure: 0, consecutiveFailures: 0 });
      }
    }

    process.stderr.write(
      `[linux-system-mcp] Available dialog backends: ${this._availableDialogBackends.join(", ") || "none"} (supported: kdialog, yad, matedialog, qarma, zenity)\n` +
      `[linux-system-mcp] Available notify backends: ${this._availableNotifyBackends.join(", ") || "none"} (supported: notify-send, kdialog, zenity, dbus-send)\n`
    );
  }

  getBackend(): DialogBackendName {
    const first = this._availableDialogBackends.find(b => b !== this._blacklistedDialogBackend);
    return first || "kdialog";
  }

  get queueDepth(): number {
    return _dialogQueueDepth;
  }

  canShowDialogs(): boolean {
    return (
      (this._availableDialogBackends.length > 0 &&
        this._availableDialogBackends.some((b) => b !== this._blacklistedDialogBackend)) ||
      isTkinterAvailable()
    );
  }

  canNotify(): boolean {
    return this._availableNotifyBackends.length > 0;
  }

  getAvailableDialogBackends(): BackendInfo[] {
    return this._availableDialogBackends.map(name => ({
      name,
      available: name !== this._blacklistedDialogBackend
    }));
  }

  getAvailableNotifyBackends(): string[] {
    return [...this._availableNotifyBackends];
  }

  /**
   * Get usage statistics for all backends (useful for debugging/monitoring)
   */
  getStats(): { dialog: Record<string, { success: number; failures: number; consecutiveFailures: number }>; notify: Record<string, { success: number; failures: number; consecutiveFailures: number }> } {
    const dialog: Record<string, { success: number; failures: number; consecutiveFailures: number }> = {};
    for (const [name, stats] of this._dialogStats) {
      dialog[name] = { success: stats.success, failures: stats.failures, consecutiveFailures: stats.consecutiveFailures };
    }
    
    const notify: Record<string, { success: number; failures: number; consecutiveFailures: number }> = {};
    for (const [name, stats] of this._notifyStats) {
      notify[name] = { success: stats.success, failures: stats.failures, consecutiveFailures: stats.consecutiveFailures };
    }
    
    return { dialog, notify };
  }

  /**
   * Get the next available dialog backend (excluding blacklisted).
   */
  private getNextDialogBackend(): DialogBackendName | null {
    return this._availableDialogBackends.find(b => b !== this._blacklistedDialogBackend) || null;
  }

  /**
   * Record a success for a dialog backend.
   */
  private recordDialogSuccess(backend: DialogBackendName): void {
    const stats = this._dialogStats.get(backend);
    if (stats) {
      stats.success++;
      stats.consecutiveFailures = 0;
    }
  }

  /**
   * Record a failure for a dialog backend and potentially blacklist it.
   */
  private recordDialogFailure(backend: DialogBackendName): void {
    const stats = this._dialogStats.get(backend);
    if (stats) {
      stats.failures++;
      stats.lastFailure = Date.now();
      stats.consecutiveFailures++;
      
      // Auto-blacklist after consecutive failures
      if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.blacklistDialogBackend(backend);
      }
    }
  }

  /**
   * Record a success for a notify backend.
   */
  private recordNotifySuccess(backend: string): void {
    const stats = this._notifyStats.get(backend);
    if (stats) {
      stats.success++;
      stats.consecutiveFailures = 0;
    }
  }

  /**
   * Record a failure for a notify backend.
   */
  private recordNotifyFailure(backend: string): void {
    const stats = this._notifyStats.get(backend);
    if (stats) {
      stats.failures++;
      stats.lastFailure = Date.now();
      stats.consecutiveFailures++;
    }
  }

  /**
   * Mark a dialog backend as failed/blacklisted.
   */
  private blacklistDialogBackend(name: DialogBackendName): void {
    if (this._blacklistedDialogBackend !== name) {
      this._blacklistedDialogBackend = name;
      process.stderr.write(
        `[linux-system-mcp] Dialog backend '${name}' blacklisted after ${MAX_CONSECUTIVE_FAILURES} failures - will try alternatives\n`
      );
    }
  }

  /**
   * Unblacklist a backend (can be called manually or after timeout).
   */
  unblacklistDialogBackend(name: DialogBackendName): void {
    if (this._blacklistedDialogBackend === name) {
      this._blacklistedDialogBackend = null;
      const stats = this._dialogStats.get(name);
      if (stats) stats.consecutiveFailures = 0;
      process.stderr.write(`[linux-system-mcp] Dialog backend '${name}' unblacklisted\n`);
    }
  }

  /**
   * Send a desktop notification.
   * Tries backends in order, fallback on failure.
   */
  async notify(options: NotifyOptions): Promise<string> {
    if (isDuplicateNotify(options.title, options.message, options.urgency || "normal")) {
      process.stderr.write(
        `[linux-system-mcp] Notification deduplicated (within ${NOTIFY_DEDUP_WINDOW_MS}ms): "${options.title}"\n`
      );
      return "dedup";
    }

    const errors: string[] = [];
    for (const backend of this._availableNotifyBackends) {
      try {
        let result: string;
        switch (backend) {
          case "notify-send":
            result = await notifySendNotify(options);
            break;
          case "kdialog":
            result = await kdialogNotify(options);
            break;
          case "zenity":
            result = await zenityNotify(options);
            break;
          case "dbus-send":
            result = await dbusNotify(options);
            break;
          default:
            continue;
        }
        
        if (result && result !== "stderr") {
          this.recordNotifySuccess(backend);
          return result;
        }
        this.recordNotifyFailure(backend);
        errors.push(`${backend}: returned ${result}`);
      } catch (err) {
        this.recordNotifyFailure(backend);
        errors.push(`${backend}: ${err instanceof Error ? err.message : err}`);
        process.stderr.write(
          `[linux-system-mcp] Notify backend '${backend}' failed: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }
    
    logFallback("all", options, errors);
    return "stderr";
  }

  /** Show an OK-only message box. */
  async alert(options: AlertOptions): Promise<AlertResult> {
    if (!this.canShowDialogs()) {
      await this.notify({ title: options.title, message: options.message }).catch(() => { });
      return { acknowledged: false, backend: "none", notAvailable: this._availableDialogBackends };
    }

    for (const backend of this._availableDialogBackends) {
      if (backend === this._blacklistedDialogBackend) continue;
      try {
        let result: AlertResult;
        switch (backend) {
          case "kdialog": result = await withDialogLock(() => kdialogAlert(options)); break;
          case "yad": result = await withDialogLock(() => yadAlert(options)); break;
          case "matedialog": result = await withDialogLock(() => matedialogAlert(options)); break;
          case "qarma": result = await withDialogLock(() => qarmaAlert(options)); break;
          case "zenity": result = await withDialogLock(() => zenityAlert(options)); break;
        }
        this.recordDialogSuccess(backend);
        return { ...result, backend };
      } catch (err) {
        this.recordDialogFailure(backend);
        process.stderr.write(
          `[linux-system-mcp] Alert backend '${backend}' failed: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }
    if (isTkinterAvailable()) {
      return await withDialogLock(() => tkinterAlert(options.title, options.message));
    }
    return { acknowledged: false, backend: "none", failed: "all dialog backends failed" };
  }

  async confirm(options: ConfirmOptions): Promise<ConfirmResult> {
    if (!this.canShowDialogs()) {
      if (isTkinterAvailable()) {
        return await withDialogLock(() => tkinterConfirm(options.title, options.message));
      }
      throw new Error(
        "Dialog support requires kdialog, zenity, or python-tkinter. " +
        `Available: ${this._availableDialogBackends.join(", ") || "none"}`
      );
    }

    for (const backend of this._availableDialogBackends) {
      if (backend === this._blacklistedDialogBackend) continue;
      try {
        let result: ConfirmResult;
        switch (backend) {
          case "kdialog": result = await withDialogLock(() => kdialogConfirm(options)); break;
          case "yad": result = await withDialogLock(() => yadConfirm(options)); break;
          case "matedialog": result = await withDialogLock(() => matedialogConfirm(options)); break;
          case "qarma": result = await withDialogLock(() => qarmaConfirm(options)); break;
          case "zenity": result = await withDialogLock(() => zenityConfirm(options)); break;
        }
        this.recordDialogSuccess(backend);
        return { ...result, backend };
      } catch (err) {
        this.recordDialogFailure(backend);
        process.stderr.write(
          `[linux-system-mcp] Confirm backend '${backend}' failed: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }

    if (isTkinterAvailable()) {
      return await withDialogLock(() => tkinterConfirm(options.title, options.message));
    }
    return { confirmed: false, backend: "none", failed: "all dialog backends failed" };
  }

  async choice(options: ChoiceOptions): Promise<ChoiceResult> {
    if (!this.canShowDialogs()) {
      if (isTkinterAvailable()) {
        return await withDialogLock(() => tkinterChoice(options.title, options.message, options.choices));
      }
      throw new Error(
        "Dialog support requires kdialog, zenity, or python-tkinter. " +
        `Available: ${this._availableDialogBackends.join(", ") || "none"}`
      );
    }
    if (options.choices.length === 0) {
      return { selected: null, index: -1, cancelled: true, backend: "none", failed: "no choices provided" };
    }

    for (const backend of this._availableDialogBackends) {
      if (backend === this._blacklistedDialogBackend) continue;
      try {
        let result: ChoiceResult;
        switch (backend) {
          case "kdialog": result = await withDialogLock(() => kdialogChoice(options)); break;
          case "yad": result = await withDialogLock(() => yadChoice(options)); break;
          case "matedialog": result = await withDialogLock(() => matedialogChoice(options)); break;
          case "qarma": result = await withDialogLock(() => qarmaChoice(options)); break;
          case "zenity": result = await withDialogLock(() => zenityChoice(options)); break;
        }
        this.recordDialogSuccess(backend);
        return { ...result, backend };
      } catch (err) {
        this.recordDialogFailure(backend);
        process.stderr.write(
          `[linux-system-mcp] Choice backend '${backend}' failed: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }

    if (isTkinterAvailable()) {
      return await withDialogLock(() => tkinterChoice(options.title, options.message, options.choices));
    }
    return { selected: null, index: -1, cancelled: true, backend: "none", failed: "all dialog backends failed" };
  }

  async multiCheck(options: MultiCheckOptions): Promise<MultiCheckResult> {
    if (!this.canShowDialogs()) {
      if (isTkinterAvailable()) {
        return await withDialogLock(() => tkinterMultiCheck(options.title, options.message, options.choices));
      }
      throw new Error(
        "Dialog support requires kdialog, zenity, or python-tkinter. " +
        `Available: ${this._availableDialogBackends.join(", ") || "none"}`
      );
    }
    if (options.choices.length === 0) {
      return { selected: [], indices: [], cancelled: true, backend: "none", failed: "no choices provided" };
    }

    for (const backend of this._availableDialogBackends) {
      if (backend === this._blacklistedDialogBackend) continue;
      try {
        let result: MultiCheckResult;
        switch (backend) {
          case "kdialog": result = await withDialogLock(() => kdialogMultiCheck(options)); break;
          case "yad": result = await withDialogLock(() => yadMultiCheck(options)); break;
          case "matedialog": result = await withDialogLock(() => matedialogMultiCheck(options)); break;
          case "qarma": result = await withDialogLock(() => qarmaMultiCheck(options)); break;
          case "zenity": result = await withDialogLock(() => zenityMultiCheck(options)); break;
        }
        this.recordDialogSuccess(backend);
        return { ...result, backend };
      } catch (err) {
        this.recordDialogFailure(backend);
        process.stderr.write(
          `[linux-system-mcp] MultiCheck backend '${backend}' failed: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }

    if (isTkinterAvailable()) {
      return await withDialogLock(() => tkinterMultiCheck(options.title, options.message, options.choices));
    }
    return { selected: [], indices: [], cancelled: true, backend: "none", failed: "all dialog backends failed" };
  }

  async input(options: InputOptions): Promise<InputResult> {
    if (!this.canShowDialogs()) {
      if (isTkinterAvailable()) {
        return await withDialogLock(() => tkinterInput(options.title, options.message, options.defaultValue));
      }
      throw new Error(
        "Dialog support requires kdialog, zenity, or python-tkinter. " +
        `Available: ${this._availableDialogBackends.join(", ") || "none"}`
      );
    }

    for (const backend of this._availableDialogBackends) {
      if (backend === this._blacklistedDialogBackend) continue;
      try {
        let result: InputResult;
        switch (backend) {
          case "kdialog": result = await withDialogLock(() => kdialogInput(options)); break;
          case "yad": result = await withDialogLock(() => yadInput(options)); break;
          case "matedialog": result = await withDialogLock(() => matedialogInput(options)); break;
          case "qarma": result = await withDialogLock(() => qarmaInput(options)); break;
          case "zenity": result = await withDialogLock(() => zenityInput(options)); break;
        }
        this.recordDialogSuccess(backend);
        return { ...result, backend };
      } catch (err) {
        this.recordDialogFailure(backend);
        process.stderr.write(
          `[linux-system-mcp] Input backend '${backend}' failed: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }

    if (isTkinterAvailable()) {
      return await withDialogLock(() => tkinterInput(options.title, options.message, options.defaultValue));
    }
    return { input: "", cancelled: true, backend: "none", failed: "all dialog backends failed" };
  }

  /**
   * Show a masked password input dialog.
   */
  async password(options: PasswordOptions): Promise<PasswordResult> {
    if (!this.canShowDialogs()) {
      if (isTkinterAvailable()) {
        return await withDialogLock(() => tkinterPassword(options.title, options.message));
      }
      throw new Error(
        "Password dialog requires kdialog, zenity, or python-tkinter. " +
        `Available: ${this._availableDialogBackends.join(", ") || "none"}`
      );
    }

    for (const backend of this._availableDialogBackends) {
      if (backend === this._blacklistedDialogBackend) continue;
      try {
        let result: PasswordResult;
        switch (backend) {
          case "kdialog": result = await withDialogLock(() => kdialogPassword(options)); break;
          case "yad": result = await withDialogLock(() => yadPassword(options)); break;
          case "matedialog": result = await withDialogLock(() => matedialogPassword(options)); break;
          case "qarma": result = await withDialogLock(() => qarmaPassword(options)); break;
          case "zenity": result = await withDialogLock(() => zenityPassword(options)); break;
        }
        this.recordDialogSuccess(backend);
        return { ...result, backend };
      } catch (err) {
        this.recordDialogFailure(backend);
        process.stderr.write(
          `[linux-system-mcp] Password backend '${backend}' failed: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }

    if (isTkinterAvailable()) {
      return await withDialogLock(() => tkinterPassword(options.title, options.message));
    }
    return { password: "", cancelled: true, backend: "none", failed: "all dialog backends failed" };
  }
}

// Singleton — nulled when kdialog is blacklisted to force backend re-resolution.
let dialogManager: DialogManager | null = null;

export function getDialogManager(): DialogManager {
  if (!dialogManager) dialogManager = new DialogManager();
  return dialogManager;
}
