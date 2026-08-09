#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { notify, notifyToolDefinition } from "./tools/notify.js";
import {
  askUser,
  askUserToolDefinition,
} from "./tools/dialogs.js";
import { shellExecute, shellExecuteToolDefinition } from "./tools/shell.js";
import { fileEdit, fileEditToolDefinition } from "./tools/file-edit.js";
import { sudoExecute, sudoExecuteToolDefinition } from "./tools/sudo.js";
import { xdgOpen, xdgOpenToolDefinition } from "./tools/xdg.js";
import { getDialogBackendStats, getDialogBackendStatsToolDefinition } from "./tools/backend-stats.js";
import { getLinuxSystemInfo, linuxSystemInfoToolDefinition } from "./tools/system-info.js";
import { mouseExecute, mouseToolDefinition } from "./tools/mouse.js";
import { keyboardExecute, keyboardToolDefinition } from "./tools/keyboard.js";
import { screenshot, screenshotToolDefinition } from "./tools/screenshot.js";
import { getDialogBackend } from "./utils/de-detect.js";
import { resolveSessionEnv, getDialogManager } from "./utils/dialog-backend.js";



// ============ INPUT VALIDATION HELPERS ============

/**
 * Validate and coerce raw MCP args.  LLMs occasionally send numbers as strings
 * or omit optional fields entirely — this catches both problems before they
 * reach the underlying tools.
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null) {
    throw new Error(`Missing required argument: "${key}"`);
  }
  if (typeof v !== "string") {
    // Coerce numbers / booleans to string rather than rejecting
    return String(v);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : String(v);
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return v;
  // LLMs sometimes send numeric args as strings ("5" instead of 5)
  const n = Number(v);
  if (!isNaN(n)) return n;
  throw new Error(`Argument "${key}" must be a number, got: ${JSON.stringify(v)}`);
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`Argument "${key}" must be a boolean, got: ${JSON.stringify(v)}`);
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) {
    throw new Error(`Argument "${key}" must be an array of strings`);
  }
  return v.map((item, i) => {
    if (typeof item !== "string") {
      throw new Error(`Argument "${key}[${i}]" must be a string, got: ${JSON.stringify(item)}`);
    }
    return item;
  });
}

function toArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Tool arguments must be an object");
  }
  return raw as Record<string, unknown>;
}

// ============ TOOLS REGISTRY ============

// All tool definitions in one place — used both for ListTools and tool_search.
const ALL_TOOLS: any[] = [
  notifyToolDefinition,
  askUserToolDefinition,         // Unified dialog tool (confirmation/choice/multi_check/input/alert/password)
  shellExecuteToolDefinition,
  sudoExecuteToolDefinition,
  // fileEditToolDefinition,      // De-registered per user request
  xdgOpenToolDefinition,
  getDialogBackendStatsToolDefinition,
  linuxSystemInfoToolDefinition,
  mouseToolDefinition,
  keyboardToolDefinition,
  screenshotToolDefinition,
];

// Inject the meta tool at index 0 so it is always first.
ALL_TOOLS.unshift({
  name: "linux_system_tool_search",
  description:
    "[meta] Search for available linux_system tools by keyword. " +
    "Use this when you need a specific capability but aren't sure which tool to call. " +
    "Returns names, descriptions, and full schemas for matching tools.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keyword to search for in tool names and descriptions",
      },
    },
    required: ["query"],
  },
});

// ============ SERVER ============

const server = new Server(
  { name: "linux-system-mcp", version: "1.0.0" },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Read defer_loading or ENABLE_DEFER_LOADING from environment or loaded .env file
  const rawVal = String(
    process.env.defer_loading ?? process.env.ENABLE_DEFER_LOADING ?? ""
  ).toLowerCase().trim();

  // Active ONLY if set to true, 1, or yes. Default is false (exposes all tools upfront).
  const enableDeferLoading = rawVal === "true" || rawVal === "1" || rawVal === "yes";

  const tools = enableDeferLoading
    ? ALL_TOOLS.filter((t) => t.name === "linux_system_tool_search")
    : ALL_TOOLS;

  return { tools };
});

// ============ PROMPTS ============

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "interactive_script_creation",
      description: "Ask the user for a script idea, generate it, and ask for confirmation to run it.",
    },
    {
      name: "open_workspace",
      description: "Prompt the user for a directory path and open it in their unified desktop environment.",
    }
  ]
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  switch (name) {
    case "interactive_script_creation":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "I want to create a new bash script. First, use `ask_user_input` to ask me what the script should do and what it should be named. Then, use `file_edit` to write the script. Finally, use `ask_user_confirmation` to ask if I want to execute it right now using `shell_execute`."
            }
          }
        ]
      };

    case "open_workspace":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Use `ask_user_input` to ask me for the path to my current project workspace. Then, use `xdg_open` to open that directory in my default file manager or IDE."
            }
          }
        ]
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  try {
    const args = toArgs(rawArgs);

    switch (name) {
      case "linux_system_tool_search": {
        const query = String(args.query || "").toLowerCase();

        const results = ALL_TOOLS.filter(
          (t: any) =>
            t.name.toLowerCase().includes(query) ||
            (t.description && t.description.toLowerCase().includes(query))
        );

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No tools found matching '${query}'. Try a broader keyword.`,
              },
            ],
          };
        }

        const formatted = results
          .map(
            (t: any) =>
              `--- Tool: ${t.name} ---\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.inputSchema, null, 2)}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} matching tool(s):\n\n${formatted}`,
            },
          ],
        };
      }

      case "notify": {
        const urgencyRaw = optionalString(args, "urgency");
        const validUrgencies = ["low", "normal", "critical"] as const;
        if (urgencyRaw && !validUrgencies.includes(urgencyRaw as (typeof validUrgencies)[number])) {
          throw new Error(`Invalid urgency: "${urgencyRaw}". Must be one of: low, normal, critical`);
        }
        const result = await notify({
          title: requireString(args, "title"),
          message: requireString(args, "message"),
          urgency: (urgencyRaw as "low" | "normal" | "critical") || "normal",
          timeout: optionalNumber(args, "timeout"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "ask_user": {
        const opRaw = requireString(args, "op");
        const validOps = ["confirmation", "choice", "multi_check", "input", "alert", "password"] as const;
        if (!validOps.includes(opRaw as (typeof validOps)[number])) {
          throw new Error(`Invalid ask_user op: "${opRaw}". Must be one of: ${validOps.join(", ")}`);
        }
        const op = opRaw as (typeof validOps)[number];
        // choices is required for choice/multi_check ops
        const needsChoices = op === "choice" || op === "multi_check";
        const result = await askUser({
          op,
          title: requireString(args, "title"),
          message: requireString(args, "message"),
          choices: needsChoices ? requireStringArray(args, "choices") : undefined,
          default_value: optionalString(args, "default_value"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "xdg_open": {
        const result = await xdgOpen({
          target: requireString(args, "target"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_dialog_backend_stats": {
        const result = await getDialogBackendStats({});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "linux_system_info": {
        const info = getLinuxSystemInfo();
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "mouse": {
        const actionRaw = requireString(args, "action");
        const validActions = ["move", "click", "double_click", "scroll", "drag", "position"] as const;
        if (!validActions.includes(actionRaw as (typeof validActions)[number])) {
          throw new Error(`Invalid mouse action: "${actionRaw}". Must be one of: move, click, double_click, scroll, drag, position`);
        }
        const result = await mouseExecute({
          action: actionRaw as "move" | "click" | "double_click" | "scroll" | "drag" | "position",
          x: optionalNumber(args, "x"),
          y: optionalNumber(args, "y"),
          startX: optionalNumber(args, "startX"),
          startY: optionalNumber(args, "startY"),
          endX: optionalNumber(args, "endX"),
          endY: optionalNumber(args, "endY"),
          button: optionalString(args, "button") as "left" | "right" | "middle" | undefined,
          direction: optionalString(args, "direction") as "up" | "down" | "left" | "right" | undefined,
          scrollAmount: optionalNumber(args, "scrollAmount"),
          duration: optionalNumber(args, "duration"),
          steps: optionalNumber(args, "steps"),
          windowId: optionalString(args, "windowId"),
          windowTitle: optionalString(args, "windowTitle"),
          windowClass: optionalString(args, "windowClass"),
          relativeToWindow: optionalBoolean(args, "relativeToWindow"),
          focusWindow: optionalBoolean(args, "focusWindow"),
          settleDelayMs: optionalNumber(args, "settleDelayMs"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "keyboard": {
        const actionRaw = requireString(args, "action");
        const validActions = ["type", "press", "key_down", "key_up", "reset"] as const;
        if (!validActions.includes(actionRaw as (typeof validActions)[number])) {
          throw new Error(`Invalid keyboard action: "${actionRaw}". Must be one of: type, press, key_down, key_up, reset`);
        }
        const result = await keyboardExecute({
          action: actionRaw as "type" | "press" | "key_down" | "key_up" | "reset",
          text: optionalString(args, "text"),
          key: optionalString(args, "key"),
          delay: optionalNumber(args, "delay"),
          windowId: optionalString(args, "windowId"),
          windowTitle: optionalString(args, "windowTitle"),
          windowClass: optionalString(args, "windowClass"),
          focusWindow: optionalBoolean(args, "focusWindow"),
          settleDelayMs: optionalNumber(args, "settleDelayMs"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "screenshot": {
        const result = await screenshot({
          format: optionalString(args, "format") as "png" | "jpg" | undefined,
          filename: optionalString(args, "filename"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "shell_execute": {
        const result = await shellExecute({
          command: requireString(args, "command"),
          working_dir: optionalString(args, "working_dir"),
          timeout: optionalNumber(args, "timeout"),
          shell: optionalString(args, "shell"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "sudo_execute": {
        const methodRaw = optionalString(args, "method");
        const validMethods = ["auto", "askpass", "pkexec", "su"] as const;
        if (methodRaw && !validMethods.includes(methodRaw as (typeof validMethods)[number])) {
          throw new Error(`Invalid sudo method: "${methodRaw}". Must be one of: auto, askpass, pkexec, su`);
        }
        const result = await sudoExecute({
          command: requireString(args, "command"),
          method: methodRaw as "auto" | "askpass" | "pkexec" | "su" | undefined,
          run_as_user: optionalString(args, "run_as_user"),
          login_shell: optionalBoolean(args, "login_shell"),
          preserve_env: optionalBoolean(args, "preserve_env"),
          nested_askpass: optionalBoolean(args, "nested_askpass"),
          notify_on_error: optionalBoolean(args, "notify_on_error"),
          working_dir: optionalString(args, "working_dir"),
          timeout: optionalNumber(args, "timeout"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "file_edit": {
        const validOps = [
          "replace", "replace_all", "insert_after", "insert_before",
          "append", "prepend", "delete_line", "delete_pattern",
        ] as const;
        const opRaw = requireString(args, "operation");
        if (!validOps.includes(opRaw as (typeof validOps)[number])) {
          throw new Error(`Invalid operation: "${opRaw}". Must be one of: ${validOps.join(", ")}`);
        }
        const result = await fileEdit({
          file_path: requireString(args, "file_path"),
          operation: opRaw as (typeof validOps)[number],
          pattern: optionalString(args, "pattern"),
          replacement: optionalString(args, "replacement"),
          line_number: optionalNumber(args, "line_number"),
          content: optionalString(args, "content"),
          create_backup: optionalBoolean(args, "create_backup"),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Log to stderr for server-side observability
    process.stderr.write(`[linux-system-mcp] Tool "${name}" error: ${message}\n`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// ============ STARTUP ============

async function main() {
  // Graceful shutdown handlers
  process.on("SIGTERM", () => {
    process.stderr.write("[linux-system-mcp] SIGTERM received — shutting down.\n");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    process.stderr.write("[linux-system-mcp] SIGINT received — shutting down.\n");
    process.exit(0);
  });

  // Warm the session-env cache now so the first tool call isn't slow.
  try {
    const env = resolveSessionEnv();
    process.stderr.write(
      `[linux-system-mcp] Session env: DISPLAY=${env.DISPLAY || "(none)"}, ` +
      `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY || "(none)"}, ` +
      `DBUS=${env.DBUS_SESSION_BUS_ADDRESS ? "present" : "absent"}\n`
    );
  } catch { /* non-fatal */ }

  try {
    const detection = getDialogBackend();
    process.stderr.write(
      `[linux-system-mcp] Desktop: ${detection.desktop} | ` +
      `Backend: ${detection.backend} | ` +
      `kdialog: ${detection.available.kdialog}, ` +
      `zenity: ${detection.available.zenity}, ` +
      `notify-send: ${detection.available.notifySend}, ` +
      `dbus-send: ${detection.available.dbusSend}\n`
    );
    if (!detection.supportsDialogs) {
      process.stderr.write(
        "[linux-system-mcp] WARNING: No dialog backend (kdialog/zenity). " +
        "confirm/choice/input tools will fail.\n"
      );
    }
    if (!detection.supportsNotify) {
      process.stderr.write(
        "[linux-system-mcp] WARNING: No notification backend at all. " +
        "Install kdialog, zenity, libnotify, or ensure dbus-send is available.\n"
      );
    }
  } catch (error) {
    process.stderr.write(
      `[linux-system-mcp] Backend detection warning: ${error instanceof Error ? error.message : error}\n`
    );
  }

  // Initialize DialogManager (logs available backends in constructor)
  try {
    getDialogManager();
  } catch (error) {
    process.stderr.write(
      `[linux-system-mcp] Dialog manager warning: ${error instanceof Error ? error.message : error}\n`
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[linux-system-mcp] Server started.\n");
}

main().catch((error) => {
  process.stderr.write(`[linux-system-mcp] Fatal error: ${error}\n`);
  process.exit(1);
});
