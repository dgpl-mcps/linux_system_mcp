import fs from "fs";
import { resolveSessionEnv } from "./dialog-backend.js";

// Linux kernel input event types & codes
const EV_SYN = 0;
const SYN_REPORT = 0;
const EV_KEY = 1;
const EV_REL = 2;

const REL_X = 0;
const REL_Y = 1;
const REL_WHEEL = 8;

const BTN_LEFT = 0x110;
const BTN_RIGHT = 0x111;
const BTN_MIDDLE = 0x112;

// Keycode mappings for common keys
const KEY_MAP: Record<string, number> = {
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36,
  k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20,
  u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  return: 28, enter: 28, space: 57, backspace: 14, tab: 15, esc: 1, escape: 1,
  ctrl: 29, control: 29, alt: 56, shift: 42, super: 125, meta: 125, win: 125,
};

let _uinputFd: number | null = null;
let _uinputSupported: boolean | null = null;

/**
 * Checks if /dev/uinput is accessible for direct Node.js kernel device writing.
 */
export function isNativeUinputAvailable(): boolean {
  if (_uinputSupported !== null) return _uinputSupported;
  try {
    const fd = fs.openSync("/dev/uinput", "w");
    fs.closeSync(fd);
    _uinputSupported = true;
  } catch {
    _uinputSupported = false;
  }
  return _uinputSupported;
}

function getUinputFd(): number | null {
  if (_uinputFd !== null) return _uinputFd;
  try {
    _uinputFd = fs.openSync("/dev/uinput", "w");
    return _uinputFd;
  } catch {
    return null;
  }
}

/**
 * Constructs binary struct input_event buffer (24 bytes on 64-bit Linux).
 */
function createInputEventBuffer(type: number, code: number, value: number): Buffer {
  const buf = Buffer.alloc(24); // timeval (16 bytes) + type (2) + code (2) + value (4)
  const nowUs = BigInt(Date.now()) * 1000n;
  const sec = nowUs / 1000000n;
  const usec = nowUs % 1000000n;

  buf.writeBigInt64LE(sec, 0);
  buf.writeBigInt64LE(usec, 8);
  buf.writeUInt16LE(type, 16);
  buf.writeUInt16LE(code, 18);
  buf.writeInt32LE(value, 20);
  return buf;
}

function writeEvent(fd: number, type: number, code: number, value: number): void {
  const evBuf = createInputEventBuffer(type, code, value);
  const synBuf = createInputEventBuffer(EV_SYN, SYN_REPORT, 0);
  fs.writeSync(fd, Buffer.concat([evBuf, synBuf]));
}

export function nativeUinputMouseMove(dx: number, dy: number): boolean {
  const fd = getUinputFd();
  if (fd === null) return false;
  try {
    if (dx !== 0) writeEvent(fd, EV_REL, REL_X, dx);
    if (dy !== 0) writeEvent(fd, EV_REL, REL_Y, dy);
    return true;
  } catch {
    return false;
  }
}

export function nativeUinputMouseClick(button: "left" | "right" | "middle" = "left"): boolean {
  const fd = getUinputFd();
  if (fd === null) return false;
  const btnCode = button === "right" ? BTN_RIGHT : button === "middle" ? BTN_MIDDLE : BTN_LEFT;
  try {
    writeEvent(fd, EV_KEY, btnCode, 1); // Press
    writeEvent(fd, EV_KEY, btnCode, 0); // Release
    return true;
  } catch {
    return false;
  }
}

export function nativeUinputMouseScroll(amount: number): boolean {
  const fd = getUinputFd();
  if (fd === null) return false;
  try {
    writeEvent(fd, EV_REL, REL_WHEEL, amount);
    return true;
  } catch {
    return false;
  }
}

export function nativeUinputKeyboardPress(keyStr: string): boolean {
  const fd = getUinputFd();
  if (fd === null) return false;
  const lower = keyStr.toLowerCase();
  const code = KEY_MAP[lower];
  if (!code) return false;
  try {
    writeEvent(fd, EV_KEY, code, 1); // Press
    writeEvent(fd, EV_KEY, code, 0); // Release
    return true;
  } catch {
    return false;
  }
}
