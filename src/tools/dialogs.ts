import { getDialogManager } from "../utils/dialog-backend.js";

// ============ ASK CONFIRMATION ============

export interface AskConfirmationParams {
  title: string;
  message: string;
}

export interface AskConfirmationResult {
  confirmed: boolean;
  backend: string;
}

export async function askConfirmation(
  params: AskConfirmationParams
): Promise<AskConfirmationResult> {
  const manager = getDialogManager();

  const result = await manager.confirm({
    title: params.title,
    message: params.message,
  });

  return {
    confirmed: result.confirmed,
    backend: manager.getBackend(),
  };
}

export const askConfirmationToolDefinition = {
  name: "ask_confirmation",
  description:
    "Show a Yes/No confirmation dialog to the user and wait for their response. Use this when you need explicit user approval before proceeding with an action (e.g., deleting files, running destructive commands).",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "The dialog title",
      },
      message: {
        type: "string",
        description: "The question or message to show the user",
      },
    },
    required: ["title", "message"],
  },
};

// ============ ASK CHOICE ============

export interface AskChoiceParams {
  title: string;
  message: string;
  choices: string[];
}

export interface AskChoiceResult {
  selected: string | null;
  index: number;
  cancelled: boolean;
  backend: string;
}

export async function askChoice(params: AskChoiceParams): Promise<AskChoiceResult> {
  const manager = getDialogManager();

  if (!params.choices || params.choices.length === 0) {
    return {
      selected: null,
      index: -1,
      cancelled: true,
      backend: manager.getBackend(),
    };
  }

  const result = await manager.choice({
    title: params.title,
    message: params.message,
    choices: params.choices,
  });

  return {
    selected: result.selected,
    index: result.index,
    cancelled: result.cancelled,
    backend: manager.getBackend(),
  };
}

export const askChoiceToolDefinition = {
  name: "ask_choice",
  description:
    "Show a multiple choice dialog to the user with a list of options. The user selects one option. Use this when you need the user to choose between several alternatives.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "The dialog title",
      },
      message: {
        type: "string",
        description: "The question or prompt for the user",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "Array of choices for the user to select from",
      },
    },
    required: ["title", "message", "choices"],
  },
};

// ============ ASK INPUT ============

export interface AskInputParams {
  title: string;
  message: string;
  default_value?: string;
}

export interface AskInputResult {
  input: string;
  cancelled: boolean;
  backend: string;
}

export async function askInput(params: AskInputParams): Promise<AskInputResult> {
  const manager = getDialogManager();

  const result = await manager.input({
    title: params.title,
    message: params.message,
    defaultValue: params.default_value,
  });

  return {
    input: result.input,
    cancelled: result.cancelled,
    backend: manager.getBackend(),
  };
}

export const askInputToolDefinition = {
  name: "ask_input",
  description:
    "Show a text input dialog to the user and get their typed response. Use this when you need free-form text input from the user (e.g., filenames, custom values, passwords).",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "The dialog title",
      },
      message: {
        type: "string",
        description: "The prompt or question for the user",
      },
      default_value: {
        type: "string",
        description: "Optional default value to pre-fill the input field",
      },
    },
    required: ["title", "message"],
  },
};
