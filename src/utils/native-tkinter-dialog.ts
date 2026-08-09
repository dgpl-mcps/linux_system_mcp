import { spawnSync } from "child_process";
import { resolveSessionEnv } from "./dialog-backend.js";

export interface TkinterConfirmResult {
  confirmed: boolean;
  backend: string;
}

export interface TkinterAlertResult {
  acknowledged: boolean;
  backend: string;
}

export interface TkinterChoiceResult {
  selected: string | null;
  index: number;
  cancelled: boolean;
  backend: string;
}

export interface TkinterMultiCheckResult {
  selected: string[];
  indices: number[];
  cancelled: boolean;
  backend: string;
}

export interface TkinterInputResult {
  input: string;
  cancelled: boolean;
  backend: string;
}

export interface TkinterPasswordResult {
  password: string;
  cancelled: boolean;
  backend: string;
}

let _tkinterAvailable: boolean | null = null;

export function isTkinterAvailable(): boolean {
  if (_tkinterAvailable !== null) return _tkinterAvailable;
  try {
    const env = resolveSessionEnv();
    const res = spawnSync("python3", ["-c", "import tkinter"], {
      stdio: "ignore",
      timeout: 2000,
      env: { ...process.env, ...env },
    });
    _tkinterAvailable = res.status === 0;
  } catch {
    _tkinterAvailable = false;
  }
  return _tkinterAvailable;
}

function runTkinterScript(pythonCode: string): string | null {
  const env = resolveSessionEnv();
  const combinedEnv = { ...process.env, ...env };
  try {
    const res = spawnSync("python3", ["-c", pythonCode], {
      encoding: "utf8",
      timeout: 120000, // 2 minutes timeout for user response
      env: combinedEnv,
    });
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
  } catch {}
  return null;
}

export async function tkinterConfirm(title: string, message: string): Promise<TkinterConfirmResult> {
  const pyCode = `
import tkinter as tk
from tkinter import messagebox
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)
res = messagebox.askyesno(${JSON.stringify(title)}, ${JSON.stringify(message)})
print("true" if res else "false")
`;
  const out = runTkinterScript(pyCode);
  const confirmed = out === "true";
  return { confirmed, backend: "python-tkinter" };
}

export async function tkinterAlert(title: string, message: string): Promise<TkinterAlertResult> {
  const pyCode = `
import tkinter as tk
from tkinter import messagebox
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)
messagebox.showinfo(${JSON.stringify(title)}, ${JSON.stringify(message)})
print("true")
`;
  const out = runTkinterScript(pyCode);
  return { acknowledged: out === "true", backend: "python-tkinter" };
}

export async function tkinterChoice(title: string, message: string, choices: string[]): Promise<TkinterChoiceResult> {
  if (choices.length === 0) {
    return { selected: null, index: -1, cancelled: true, backend: "python-tkinter" };
  }

  const pyCode = `
import tkinter as tk
import json

root = tk.Tk()
root.title(${JSON.stringify(title)})
root.geometry("440x350")
root.attributes("-topmost", True)

tk.Label(root, text=${JSON.stringify(message)}, wraplength=400, justify="left", font=("Helvetica", 10, "bold")).pack(anchor="w", padx=15, pady=10)

selected_idx = tk.IntVar(value=0)
choices = ${JSON.stringify(choices)}

frame = tk.Frame(root)
frame.pack(fill="both", expand=True, padx=15, pady=5)

for i, choice in enumerate(choices):
    tk.Radiobutton(frame, text=choice, variable=selected_idx, value=i, font=("Helvetica", 10)).pack(anchor="w", pady=3)

res = {"idx": -1, "cancelled": True}

function_submit = lambda: [res.update({"idx": selected_idx.get(), "cancelled": False}), root.destroy()]
function_cancel = lambda: root.destroy()

btn_frame = tk.Frame(root)
btn_frame.pack(fill="x", padx=15, pady=10)

tk.Button(btn_frame, text="Select", command=function_submit, width=10, bg="#2563eb", fg="white", font=("Helvetica", 10, "bold")).pack(side="right", padx=5)
tk.Button(btn_frame, text="Cancel", command=function_cancel, width=10, font=("Helvetica", 10)).pack(side="right", padx=5)

root.mainloop()
print(json.dumps(res))
`;

  const out = runTkinterScript(pyCode);
  if (out) {
    try {
      const parsed = JSON.parse(out);
      if (!parsed.cancelled && parsed.idx >= 0 && parsed.idx < choices.length) {
        return {
          selected: choices[parsed.idx],
          index: parsed.idx,
          cancelled: false,
          backend: "python-tkinter",
        };
      }
    } catch {}
  }

  return { selected: null, index: -1, cancelled: true, backend: "python-tkinter" };
}

export async function tkinterMultiCheck(
  title: string,
  message: string,
  choices: string[]
): Promise<TkinterMultiCheckResult> {
  if (choices.length === 0) {
    return { selected: [], indices: [], cancelled: true, backend: "python-tkinter" };
  }

  const pyCode = `
import tkinter as tk
import json

root = tk.Tk()
root.title(${JSON.stringify(title)})
root.geometry("460x380")
root.attributes("-topmost", True)

tk.Label(root, text=${JSON.stringify(message)}, wraplength=420, justify="left", font=("Helvetica", 10, "bold")).pack(anchor="w", padx=15, pady=10)

choices = ${JSON.stringify(choices)}
vars_list = []

frame = tk.Frame(root)
frame.pack(fill="both", expand=True, padx=15, pady=5)

for i, choice in enumerate(choices):
    v = tk.BooleanVar(value=False)
    vars_list.append(v)
    tk.Checkbutton(frame, text=choice, variable=v, font=("Helvetica", 10)).pack(anchor="w", pady=3)

res = {"indices": [], "cancelled": True}

def on_submit():
    res["indices"] = [i for i, v in enumerate(vars_list) if v.get()]
    res["cancelled"] = False
    root.destroy()

def on_cancel():
    root.destroy()

btn_frame = tk.Frame(root)
btn_frame.pack(fill="x", padx=15, pady=10)

tk.Button(btn_frame, text="Submit", command=on_submit, width=10, bg="#2563eb", fg="white", font=("Helvetica", 10, "bold")).pack(side="right", padx=5)
tk.Button(btn_frame, text="Cancel", command=on_cancel, width=10, font=("Helvetica", 10)).pack(side="right", padx=5)

root.mainloop()
print(json.dumps(res))
`;

  const out = runTkinterScript(pyCode);
  if (out) {
    try {
      const parsed = JSON.parse(out);
      if (!parsed.cancelled && Array.isArray(parsed.indices)) {
        const selected = parsed.indices.map((i: number) => choices[i]).filter(Boolean);
        return {
          selected,
          indices: parsed.indices,
          cancelled: false,
          backend: "python-tkinter",
        };
      }
    } catch {}
  }

  return { selected: [], indices: [], cancelled: true, backend: "python-tkinter" };
}

export async function tkinterInput(
  title: string,
  message: string,
  defaultValue?: string
): Promise<TkinterInputResult> {
  const pyCode = `
import tkinter as tk
import json

root = tk.Tk()
root.title(${JSON.stringify(title)})
root.geometry("420x200")
root.attributes("-topmost", True)

tk.Label(root, text=${JSON.stringify(message)}, wraplength=380, justify="left", font=("Helvetica", 10, "bold")).pack(anchor="w", padx=15, pady=10)

entry = tk.Entry(root, font=("Helvetica", 10))
entry.insert(0, ${JSON.stringify(defaultValue || "")})
entry.pack(fill="x", padx=15, pady=5)
entry.focus_set()

res = {"input": "", "cancelled": True}

def on_submit(event=None):
    res["input"] = entry.get()
    res["cancelled"] = False
    root.destroy()

def on_cancel():
    root.destroy()

root.bind("<Return>", on_submit)

btn_frame = tk.Frame(root)
btn_frame.pack(fill="x", padx=15, pady=15)

tk.Button(btn_frame, text="OK", command=on_submit, width=10, bg="#2563eb", fg="white", font=("Helvetica", 10, "bold")).pack(side="right", padx=5)
tk.Button(btn_frame, text="Cancel", command=on_cancel, width=10, font=("Helvetica", 10)).pack(side="right", padx=5)

root.mainloop()
print(json.dumps(res))
`;

  const out = runTkinterScript(pyCode);
  if (out) {
    try {
      const parsed = JSON.parse(out);
      if (!parsed.cancelled) {
        return { input: parsed.input, cancelled: false, backend: "python-tkinter" };
      }
    } catch {}
  }

  return { input: "", cancelled: true, backend: "python-tkinter" };
}

export async function tkinterPassword(title: string, message: string): Promise<TkinterPasswordResult> {
  const pyCode = `
import tkinter as tk
import json

root = tk.Tk()
root.title(${JSON.stringify(title)})
root.geometry("420x200")
root.attributes("-topmost", True)

tk.Label(root, text=${JSON.stringify(message)}, wraplength=380, justify="left", font=("Helvetica", 10, "bold")).pack(anchor="w", padx=15, pady=10)

entry = tk.Entry(root, show="*", font=("Helvetica", 10))
entry.pack(fill="x", padx=15, pady=5)
entry.focus_set()

res = {"password": "", "cancelled": True}

def on_submit(event=None):
    res["password"] = entry.get()
    res["cancelled"] = False
    root.destroy()

def on_cancel():
    root.destroy()

root.bind("<Return>", on_submit)

btn_frame = tk.Frame(root)
btn_frame.pack(fill="x", padx=15, pady=15)

tk.Button(btn_frame, text="OK", command=on_submit, width=10, bg="#2563eb", fg="white", font=("Helvetica", 10, "bold")).pack(side="right", padx=5)
tk.Button(btn_frame, text="Cancel", command=on_cancel, width=10, font=("Helvetica", 10)).pack(side="right", padx=5)

root.mainloop()
print(json.dumps(res))
`;

  const out = runTkinterScript(pyCode);
  if (out) {
    try {
      const parsed = JSON.parse(out);
      if (!parsed.cancelled) {
        return { password: parsed.password, cancelled: false, backend: "python-tkinter" };
      }
    } catch {}
  }

  return { password: "", cancelled: true, backend: "python-tkinter" };
}
