#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { notify, notifyToolDefinition } from "./tools/notify.js";
import {
  askConfirmation,
  askConfirmationToolDefinition,
  askChoice,
  askChoiceToolDefinition,
  askInput,
  askInputToolDefinition,
} from "./tools/dialogs.js";
import { shellExecute, shellExecuteToolDefinition } from "./tools/shell.js";
import { fileEdit, fileEditToolDefinition } from "./tools/file-edit.js";
import { sudoExecute, sudoExecuteToolDefinition } from "./tools/sudo.js";
import { getDialogBackend } from "./utils/de-detect.js";

const server = new Server(
  {
    name: "linux-system-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      notifyToolDefinition,
      askConfirmationToolDefinition,
      askChoiceToolDefinition,
      askInputToolDefinition,
      shellExecuteToolDefinition,
      sudoExecuteToolDefinition,
      fileEditToolDefinition,
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "notify": {
        const params = args as {
          title: string;
          message: string;
          urgency?: "low" | "normal" | "critical";
          timeout?: number;
        };
        const result = await notify(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "ask_confirmation": {
        const params = args as {
          title: string;
          message: string;
        };
        const result = await askConfirmation(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "ask_choice": {
        const params = args as {
          title: string;
          message: string;
          choices: string[];
        };
        const result = await askChoice(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "ask_input": {
        const params = args as {
          title: string;
          message: string;
          default_value?: string;
        };
        const result = await askInput(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "shell_execute": {
        const params = args as {
          command: string;
          working_dir?: string;
          timeout?: number;
          shell?: string;
        };
        const result = await shellExecute(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "sudo_execute": {
        const params = args as {
          command: string;
          method?: "askpass" | "pkexec";
          run_as_user?: string;
          login_shell?: boolean;
          preserve_env?: boolean;
          nested_askpass?: boolean;
          notify_on_error?: boolean;
          working_dir?: string;
          timeout?: number;
        };
        const result = await sudoExecute(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "file_edit": {
        const params = args as {
          file_path: string;
          operation:
            | "replace"
            | "replace_all"
            | "insert_after"
            | "insert_before"
            | "append"
            | "prepend"
            | "delete_line"
            | "delete_pattern";
          pattern?: string;
          replacement?: string;
          line_number?: number;
          content?: string;
          create_backup?: boolean;
        };
        const result = await fileEdit(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  // Log detected backend for debugging (to stderr so it doesn't interfere with MCP)
  try {
    const detection = getDialogBackend();
    console.error(
      `[linux-system-mcp] Detected desktop: ${detection.desktop}, using backend: ${detection.backend}`
    );
    console.error(
      `[linux-system-mcp] Available: kdialog=${detection.available.kdialog}, zenity=${detection.available.zenity}, notify-send=${detection.available.notifySend}`
    );
    if (!detection.supportsDialogs) {
      console.error(
        `[linux-system-mcp] WARNING: Dialog support limited (no kdialog/zenity). Install one for full functionality.`
      );
    }
  } catch (error) {
    console.error(
      `[linux-system-mcp] Warning: ${error instanceof Error ? error.message : error}`
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[linux-system-mcp] Server started");
}

main().catch((error) => {
  console.error("[linux-system-mcp] Fatal error:", error);
  process.exit(1);
});
