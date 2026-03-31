import { readFile, writeFile, copyFile, access } from "fs/promises";
import { constants } from "fs";
import { dirname, basename, join } from "path";

export type FileEditOperation =
  | "replace"
  | "replace_all"
  | "insert_after"
  | "insert_before"
  | "append"
  | "prepend"
  | "delete_line"
  | "delete_pattern";

export interface FileEditParams {
  file_path: string;
  operation: FileEditOperation;
  pattern?: string; // regex or line number for some operations
  replacement?: string;
  line_number?: number;
  content?: string; // for append/prepend
  create_backup?: boolean;
}

export interface FileEditResult {
  success: boolean;
  backup_path?: string;
  error?: string;
  lines_affected: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function createBackup(filePath: string): Promise<string> {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dir, `.${name}.${timestamp}.bak`);
  await copyFile(filePath, backupPath);
  return backupPath;
}

export async function fileEdit(params: FileEditParams): Promise<FileEditResult> {
  try {
    // Check if file exists for operations that require it
    const exists = await fileExists(params.file_path);
    if (!exists && !["append", "prepend"].includes(params.operation)) {
      return {
        success: false,
        error: `File not found: ${params.file_path}`,
        lines_affected: 0,
      };
    }

    // Read existing content
    let content = "";
    if (exists) {
      content = await readFile(params.file_path, "utf-8");
    }

    // Create backup if requested
    let backupPath: string | undefined;
    if (params.create_backup && exists) {
      backupPath = await createBackup(params.file_path);
    }

    let lines = content.split("\n");
    let linesAffected = 0;

    switch (params.operation) {
      case "replace": {
        // Replace first occurrence of pattern
        if (!params.pattern || params.replacement === undefined) {
          return {
            success: false,
            error: "replace operation requires pattern and replacement",
            lines_affected: 0,
          };
        }
        const regex = new RegExp(params.pattern);
        const newLines = lines.map((line) => {
          if (regex.test(line) && linesAffected === 0) {
            linesAffected++;
            return line.replace(regex, params.replacement!);
          }
          return line;
        });
        lines = newLines;
        break;
      }

      case "replace_all": {
        // Replace all occurrences of pattern
        if (!params.pattern || params.replacement === undefined) {
          return {
            success: false,
            error: "replace_all operation requires pattern and replacement",
            lines_affected: 0,
          };
        }
        const regex = new RegExp(params.pattern, "g");
        const newLines = lines.map((line) => {
          if (regex.test(line)) {
            linesAffected++;
            return line.replace(new RegExp(params.pattern!, "g"), params.replacement!);
          }
          return line;
        });
        lines = newLines;
        break;
      }

      case "insert_after": {
        // Insert content after line matching pattern or at line number
        if (!params.content) {
          return {
            success: false,
            error: "insert_after operation requires content",
            lines_affected: 0,
          };
        }

        if (params.line_number !== undefined) {
          const idx = params.line_number - 1; // 1-based to 0-based
          if (idx >= 0 && idx < lines.length) {
            lines.splice(idx + 1, 0, params.content);
            linesAffected = 1;
          }
        } else if (params.pattern) {
          const regex = new RegExp(params.pattern);
          const newLines: string[] = [];
          for (const line of lines) {
            newLines.push(line);
            if (regex.test(line)) {
              newLines.push(params.content);
              linesAffected++;
            }
          }
          lines = newLines;
        }
        break;
      }

      case "insert_before": {
        // Insert content before line matching pattern or at line number
        if (!params.content) {
          return {
            success: false,
            error: "insert_before operation requires content",
            lines_affected: 0,
          };
        }

        if (params.line_number !== undefined) {
          const idx = params.line_number - 1;
          if (idx >= 0 && idx <= lines.length) {
            lines.splice(idx, 0, params.content);
            linesAffected = 1;
          }
        } else if (params.pattern) {
          const regex = new RegExp(params.pattern);
          const newLines: string[] = [];
          for (const line of lines) {
            if (regex.test(line)) {
              newLines.push(params.content);
              linesAffected++;
            }
            newLines.push(line);
          }
          lines = newLines;
        }
        break;
      }

      case "append": {
        // Append content to end of file
        if (!params.content) {
          return {
            success: false,
            error: "append operation requires content",
            lines_affected: 0,
          };
        }
        if (content && !content.endsWith("\n")) {
          lines.push("");
        }
        lines.push(params.content);
        linesAffected = 1;
        break;
      }

      case "prepend": {
        // Prepend content to start of file
        if (!params.content) {
          return {
            success: false,
            error: "prepend operation requires content",
            lines_affected: 0,
          };
        }
        lines.unshift(params.content);
        linesAffected = 1;
        break;
      }

      case "delete_line": {
        // Delete line at line number
        if (params.line_number === undefined) {
          return {
            success: false,
            error: "delete_line operation requires line_number",
            lines_affected: 0,
          };
        }
        const idx = params.line_number - 1;
        if (idx >= 0 && idx < lines.length) {
          lines.splice(idx, 1);
          linesAffected = 1;
        }
        break;
      }

      case "delete_pattern": {
        // Delete all lines matching pattern
        if (!params.pattern) {
          return {
            success: false,
            error: "delete_pattern operation requires pattern",
            lines_affected: 0,
          };
        }
        const regex = new RegExp(params.pattern);
        const originalLength = lines.length;
        lines = lines.filter((line) => !regex.test(line));
        linesAffected = originalLength - lines.length;
        break;
      }

      default:
        return {
          success: false,
          error: `Unknown operation: ${params.operation}`,
          lines_affected: 0,
        };
    }

    // Write the modified content
    await writeFile(params.file_path, lines.join("\n"), "utf-8");

    return {
      success: true,
      backup_path: backupPath,
      lines_affected: linesAffected,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      lines_affected: 0,
    };
  }
}

export const fileEditToolDefinition = {
  name: "file_edit",
  description:
    "Edit a file using various operations like replace, insert, append, or delete. Supports regex patterns for matching. Can create backups before modification. Chain with ask_confirmation if you are modifying a critical system file interactively, or with xdg_open to show the user the edited file afterwards.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      operation: {
        type: "string",
        enum: [
          "replace",
          "replace_all",
          "insert_after",
          "insert_before",
          "append",
          "prepend",
          "delete_line",
          "delete_pattern",
        ],
        description:
          "The edit operation to perform: replace (first match), replace_all, insert_after, insert_before, append, prepend, delete_line, delete_pattern",
      },
      pattern: {
        type: "string",
        description: "Regex pattern to match (for replace, insert_after/before, delete_pattern)",
      },
      replacement: {
        type: "string",
        description: "Replacement text (for replace operations)",
      },
      line_number: {
        type: "number",
        description: "Line number (1-based) for line-specific operations",
      },
      content: {
        type: "string",
        description: "Content to insert (for insert/append/prepend operations)",
      },
      create_backup: {
        type: "boolean",
        description: "Create a backup file before editing (default: false)",
      },
    },
    required: ["file_path", "operation"],
  },
};
