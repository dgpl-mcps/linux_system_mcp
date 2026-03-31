import { getDialogManager } from "../utils/dialog-backend.js";

// ============ INDIVIDUAL FUNCTIONS (internal / reusable) ============

export interface AskConfirmationParams { title: string; message: string; }
export interface AskConfirmationResult { confirmed: boolean; backend: string; }

export async function askConfirmation(params: AskConfirmationParams): Promise<AskConfirmationResult> {
  const manager = getDialogManager();
  const result = await manager.confirm({ title: params.title, message: params.message });
  return { confirmed: result.confirmed, backend: result.backend };
}

export interface AskChoiceParams { title: string; message: string; choices: string[]; }
export interface AskChoiceResult { selected: string | null; index: number; cancelled: boolean; backend: string; }

export async function askChoice(params: AskChoiceParams): Promise<AskChoiceResult> {
  const manager = getDialogManager();
  if (!params.choices || params.choices.length === 0) {
    return { selected: null, index: -1, cancelled: true, backend: manager.getBackend() };
  }
  const result = await manager.choice({ title: params.title, message: params.message, choices: params.choices });
  return { selected: result.selected, index: result.index, cancelled: result.cancelled, backend: result.backend };
}

export interface AskMultiCheckParams { title: string; message: string; choices: string[]; }
export interface AskMultiCheckResult { selected: string[]; indices: number[]; cancelled: boolean; backend: string; }

export async function askMultiCheck(params: AskMultiCheckParams): Promise<AskMultiCheckResult> {
  const manager = getDialogManager();
  if (!params.choices || params.choices.length === 0) {
    return { selected: [], indices: [], cancelled: true, backend: manager.getBackend() };
  }
  const result = await manager.multiCheck({ title: params.title, message: params.message, choices: params.choices });
  return { selected: result.selected, indices: result.indices, cancelled: result.cancelled, backend: result.backend };
}

export interface AskInputParams { title: string; message: string; default_value?: string; }
export interface AskInputResult { input: string; cancelled: boolean; backend: string; }

export async function askInput(params: AskInputParams): Promise<AskInputResult> {
  const manager = getDialogManager();
  const result = await manager.input({ title: params.title, message: params.message, defaultValue: params.default_value });
  return { input: result.input, cancelled: result.cancelled, backend: result.backend };
}

export interface ShowAlertParams { title: string; message: string; }
export interface ShowAlertResult { acknowledged: boolean; backend: string; }

export async function showAlert(params: ShowAlertParams): Promise<ShowAlertResult> {
  const manager = getDialogManager();
  const result = await manager.alert({ title: params.title, message: params.message });
  return { acknowledged: result.acknowledged, backend: result.backend };
}

export interface AskPasswordParams { title: string; message: string; }
export interface AskPasswordResult { password: string; cancelled: boolean; backend: string; }

export async function askPassword(params: AskPasswordParams): Promise<AskPasswordResult> {
  const manager = getDialogManager();
  const result = await manager.password({ title: params.title, message: params.message });
  return { password: result.password, cancelled: result.cancelled, backend: result.backend };
}

// ============ UNIFIED ask_user TOOL ============

export type AskUserOp = "confirmation" | "choice" | "multi_check" | "input" | "alert" | "password";

export interface AskUserParams {
  op: AskUserOp;
  title: string;
  message: string;
  choices?: string[];       // required for op: choice, multi_check
  default_value?: string;   // optional for op: input
}

/**
 * Unified dialog dispatcher — routes to the correct underlying dialog
 * based on the `op` field.
 */
export async function askUser(params: AskUserParams): Promise<Record<string, unknown>> {
  switch (params.op) {
    case "confirmation":
      return askConfirmation({ title: params.title, message: params.message }) as unknown as Record<string, unknown>;
    case "choice":
      return askChoice({ title: params.title, message: params.message, choices: params.choices ?? [] }) as unknown as Record<string, unknown>;
    case "multi_check":
      return askMultiCheck({ title: params.title, message: params.message, choices: params.choices ?? [] }) as unknown as Record<string, unknown>;
    case "input":
      return askInput({ title: params.title, message: params.message, default_value: params.default_value }) as unknown as Record<string, unknown>;
    case "alert":
      return showAlert({ title: params.title, message: params.message }) as unknown as Record<string, unknown>;
    case "password":
      return askPassword({ title: params.title, message: params.message }) as unknown as Record<string, unknown>;
    default:
      throw new Error(`Unknown ask_user op: "${(params as AskUserParams).op}". Must be one of: confirmation, choice, multi_check, input, alert, password`);
  }
}

export const askUserToolDefinition = {
  name: "ask_user",
  description:
    "Show an interactive GUI dialog to the user and return their response. " +
    "Use 'op' to select the dialog type:\n" +
    "  • confirmation — Yes/No prompt. Returns: { confirmed: bool }\n" +
    "  • choice       — Pick one from a list. Returns: { selected: str, index: int, cancelled: bool }\n" +
    "  • multi_check  — Tick multiple items. Returns: { selected: str[], indices: int[], cancelled: bool }\n" +
    "  • input        — Free-text entry. Returns: { input: str, cancelled: bool }\n" +
    "  • alert        — OK-only popup (blocks until dismissed). Returns: { acknowledged: bool }\n" +
    "  • password     — Masked secret entry. Returns: { password: str, cancelled: bool }\n" +
    "Rules: always use ask_user_confirmation before destructive ops. " +
    "Prefer notify (fire-and-forget) over alert for status updates.",
  inputSchema: {
    type: "object" as const,
    properties: {
      op: {
        type: "string",
        enum: ["confirmation", "choice", "multi_check", "input", "alert", "password"],
        description:
          "Dialog type. confirmation=yes/no, choice=pick one, multi_check=tick many, input=text entry, alert=ok popup, password=masked input",
      },
      title: {
        type: "string",
        description: "Dialog window title",
      },
      message: {
        type: "string",
        description: "Main text shown to the user",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "List of options (required for op: choice and multi_check)",
      },
      default_value: {
        type: "string",
        description: "Pre-filled value shown in the input field (op: input only)",
      },
    },
    required: ["op", "title", "message"],
  },
};

// ---- Legacy individual definitions kept for backwards compatibility ----
// (Not registered in ALL_TOOLS — use askUserToolDefinition instead)

export const askConfirmationToolDefinition = {
  name: "ask_user_confirmation",
  description: "[legacy] Use ask_user with op=confirmation instead.",
  inputSchema: { type: "object" as const, properties: { title: { type: "string" }, message: { type: "string" } }, required: ["title", "message"] },
};
export const askChoiceToolDefinition = {
  name: "ask_user_choice",
  description: "[legacy] Use ask_user with op=choice instead.",
  inputSchema: { type: "object" as const, properties: { title: { type: "string" }, message: { type: "string" }, choices: { type: "array", items: { type: "string" } } }, required: ["title", "message", "choices"] },
};
export const askMultiCheckToolDefinition = {
  name: "ask_user_multi_check",
  description: "[legacy] Use ask_user with op=multi_check instead.",
  inputSchema: { type: "object" as const, properties: { title: { type: "string" }, message: { type: "string" }, choices: { type: "array", items: { type: "string" } } }, required: ["title", "message", "choices"] },
};
export const askInputToolDefinition = {
  name: "ask_user_input",
  description: "[legacy] Use ask_user with op=input instead.",
  inputSchema: { type: "object" as const, properties: { title: { type: "string" }, message: { type: "string" }, default_value: { type: "string" } }, required: ["title", "message"] },
};
export const showAlertToolDefinition = {
  name: "show_user_alert",
  description: "[legacy] Use ask_user with op=alert instead.",
  inputSchema: { type: "object" as const, properties: { title: { type: "string" }, message: { type: "string" } }, required: ["title", "message"] },
};
export const askPasswordToolDefinition = {
  name: "ask_user_password",
  description: "[legacy] Use ask_user with op=password instead.",
  inputSchema: { type: "object" as const, properties: { title: { type: "string" }, message: { type: "string" } }, required: ["title", "message"] },
};
