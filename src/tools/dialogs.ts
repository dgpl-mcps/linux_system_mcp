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
    "Show an interactive Yes/No confirmation dialog to the user and wait for their response. Use this when you need explicit interactive user approval before proceeding with an action (e.g., deleting files, running destructive commands).",
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
    "Show an interactive multiple choice dialog to the user with a list of options. The user interactively selects one option. Use this when you need the user to interactively choose between several alternatives. " +
    "EXAMPLE ADVANCED USAGE: Tool Chaining. You can use this to ask the user what they want to do next. For example, if a directory is missing, you can ask_choice: ['Create it', 'Provide new path', 'Abort']. If they select 'Provide new path', you then chain into `ask_input` to get the path. If they select 'Create it', you chain into `shell_execute` to run `mkdir`. This creates a fully interactive agentic flow.",
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
    "Show an interactive text input dialog to the user and get their typed response. Use this when you need free-form interactive text input from the user (e.g., filenames, custom values, passwords). " +
    "EXAMPLE ADVANCED USAGE: Tool Chaining. This is often chained after an `ask_choice` step. For example, if the user chose 'Custom branch name' in a previous ask_choice, you can use ask_input to actually ask the user to type out the custom branch name, and then pass their input to `shell_execute`.",
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

// ============ SHOW ALERT ============

export interface ShowAlertParams {
  title: string;
  message: string;
}

export interface ShowAlertResult {
  acknowledged: boolean;
  backend: string;
}

export async function showAlert(params: ShowAlertParams): Promise<ShowAlertResult> {
  const manager = getDialogManager();

  const result = await manager.alert({
    title: params.title,
    message: params.message,
  });

  return {
    acknowledged: result.acknowledged,
    backend: manager.getBackend(),
  };
}

export const showAlertToolDefinition = {
  name: "show_alert",
  description: "Display an interactive OK-only alert dialog. For fire-and-forget background updates, prefer using the `notify` tool over this. Use `show_alert` when you absolutely must interactively interrupt the user and force them to explicitly dismiss the message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "The dialog title",
      },
      message: {
        type: "string",
        description: "The message to display to the user",
      },
    },
    required: ["title", "message"],
  },
};

// ============ ASK PASSWORD ============

export interface AskPasswordParams {
  title: string;
  message: string;
}

export interface AskPasswordResult {
  password: string;
  cancelled: boolean;
  backend: string;
}

export async function askPassword(params: AskPasswordParams): Promise<AskPasswordResult> {
  const manager = getDialogManager();

  const result = await manager.password({
    title: params.title,
    message: params.message,
  });

  return {
    password: result.password,
    cancelled: result.cancelled,
    backend: manager.getBackend(),
  };
}

export const askPasswordToolDefinition = {
  name: "ask_password",
  description: "Display an interactive password input dialog where the text is masked. Use this when a script or remote authentication step requires a secret interactively from the user, then pass the result securely to the appropriate tool.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "The dialog title",
      },
      message: {
        type: "string",
        description: "The prompt shown to the user (e.g. 'Enter your sudo password')",
      },
    },
    required: ["title", "message"],
  },
};
