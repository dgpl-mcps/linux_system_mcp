import { spawn, execSync } from "child_process";
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

export interface ChoiceResult {
  selected: string | null;
  index: number;
  cancelled: boolean;
}

export interface InputResult {
  input: string;
  cancelled: boolean;
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function runCommand(cmd: string, args: string[], timeoutMs: number = 30000, extraEnv: Record<string, string> = {}): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0", ...extraEnv },
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

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: stdout.trim(), exitCode: code ?? 1 });
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout: "", exitCode: 1 });
      }
    });
  });
}

// ============ KDIALOG IMPLEMENTATION ============

/** Run kdialog with QT_QPA_PLATFORM=xcb forced so it doesn't crash when Qt
 *  can't auto-detect a platform plugin (e.g. when launched from a browser/Chromium scope). */
function runKdialog(args: string[], timeoutMs?: number): Promise<{ stdout: string; exitCode: number }> {
  return runCommand("kdialog", args, timeoutMs, { QT_QPA_PLATFORM: "xcb" });
}

async function kdialogNotify(options: NotifyOptions): Promise<void> {
  const timeout = options.timeout ?? 5;
  const args = [
    "--passivepopup",
    `${options.title}\n\n${options.message}`,
    String(timeout),
  ];
  const result = await runKdialog(args);
  // If kdialog crashed / aborted (signal 6 → exitCode 134, or any non-zero),
  // fall back to notify-send so the notification is never silently lost.
  if (result.exitCode !== 0) {
    await notifySendNotify(options);
  }
}

async function kdialogConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const args = [
    "--title",
    options.title,
    "--yesno",
    options.message,
  ];
  const result = await runKdialog(args);
  return { confirmed: result.exitCode === 0 };
}

async function kdialogChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  // kdialog --menu "message" tag1 "item1" tag2 "item2" ...
  const args = [
    "--title",
    options.title,
    "--menu",
    options.message,
  ];

  options.choices.forEach((choice, index) => {
    args.push(String(index), choice);
  });

  const result = await runKdialog(args);

  if (result.exitCode !== 0) {
    return { selected: null, index: -1, cancelled: true };
  }

  const selectedIndex = parseInt(result.stdout, 10);
  return {
    selected: options.choices[selectedIndex] || null,
    index: selectedIndex,
    cancelled: false,
  };
}

async function kdialogInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--title",
    options.title,
    "--inputbox",
    options.message,
    options.defaultValue || "",
  ];

  const result = await runKdialog(args);

  if (result.exitCode !== 0) {
    return { input: "", cancelled: true };
  }

  return { input: result.stdout, cancelled: false };
}

// ============ ZENITY IMPLEMENTATION ============

async function zenityNotify(options: NotifyOptions): Promise<void> {
  const args = [
    "--notification",
    "--text",
    `${options.title}\n${options.message}`,
  ];

  // zenity notification doesn't support timeout directly, use notify-send as fallback
  try {
    const urgencyMap: Record<Urgency, string> = {
      low: "low",
      normal: "normal",
      critical: "critical",
    };
    const notifyArgs = [
      "-u",
      urgencyMap[options.urgency || "normal"],
      "-t",
      String((options.timeout ?? 5) * 1000),
      options.title,
      options.message,
    ];
    await runCommand("notify-send", notifyArgs);
  } catch {
    // Fallback to zenity
    await runCommand("zenity", args);
  }
}

async function zenityConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const args = [
    "--question",
    "--title",
    options.title,
    "--text",
    options.message,
    "--width",
    "400",
  ];
  const result = await runCommand("zenity", args);
  return { confirmed: result.exitCode === 0 };
}

async function zenityChoice(options: ChoiceOptions): Promise<ChoiceResult> {
  // zenity --list --radiolist --column "Select" --column "Option" FALSE "opt1" FALSE "opt2" ...
  const args = [
    "--list",
    "--radiolist",
    "--title",
    options.title,
    "--text",
    options.message,
    "--column",
    "Select",
    "--column",
    "Option",
    "--width",
    "400",
    "--height",
    "300",
  ];

  options.choices.forEach((choice, index) => {
    args.push(index === 0 ? "TRUE" : "FALSE", choice);
  });

  const result = await runCommand("zenity", args);

  if (result.exitCode !== 0 || !result.stdout) {
    return { selected: null, index: -1, cancelled: true };
  }

  const selected = result.stdout;
  const index = options.choices.indexOf(selected);

  return {
    selected,
    index,
    cancelled: false,
  };
}

async function zenityInput(options: InputOptions): Promise<InputResult> {
  const args = [
    "--entry",
    "--title",
    options.title,
    "--text",
    options.message,
    "--width",
    "400",
  ];

  if (options.defaultValue) {
    args.push("--entry-text", options.defaultValue);
  }

  const result = await runCommand("zenity", args);

  if (result.exitCode !== 0) {
    return { input: "", cancelled: true };
  }

  return { input: result.stdout, cancelled: false };
}

// ============ NOTIFY-SEND ONLY IMPLEMENTATION ============

async function notifySendNotify(options: NotifyOptions): Promise<void> {
  const urgencyMap: Record<Urgency, string> = {
    low: "low",
    normal: "normal",
    critical: "critical",
  };
  const args = [
    "-u",
    urgencyMap[options.urgency || "normal"],
    "-t",
    String((options.timeout ?? 5) * 1000),
    options.title,
    options.message,
  ];
  // notify-send should complete quickly, use short timeout
  await runCommand("notify-send", args, 5000);
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

  async notify(options: NotifyOptions): Promise<void> {
    if (this.backend === "kdialog") {
      return kdialogNotify(options);
    } else if (this.backend === "zenity") {
      return zenityNotify(options);
    } else {
      return notifySendNotify(options);
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
