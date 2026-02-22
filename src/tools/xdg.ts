import { spawn } from "child_process";
import { resolveSessionEnv } from "../utils/dialog-backend.js";

export const xdgOpenToolDefinition = {
    name: "xdg_open",
    description: "Open a file, directory, or URL using the user's default GUI application.",
    inputSchema: {
        type: "object" as const,
        properties: {
            target: {
                type: "string",
                description: "The file path, directory path, or URL to open",
            },
        },
        required: ["target"],
    },
};

export async function xdgOpen(params: { target: string }): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
        const env = resolveSessionEnv();
        const proc = spawn("xdg-open", [params.target], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, ...env },
        });
        proc.unref();

        return {
            success: true,
            message: `Opened "${params.target}" in the default desktop application.`
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
