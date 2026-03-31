# 🐧 Linux System MCP Server

*The ultimate bridge between AI Agents and the Linux Desktop.*

> **Vibe Coded** ✨ 
> *Built with the mind and idea of a human, and the execution and speed of an AI.*

Welcome, Linux lovers! We are open-sourcing this Model Context Protocol (MCP) server because the Linux desktop deserves first-class AI integration. This project provides a critical safety and usability layer, allowing AI agents to interact with your system intelligently, safely, and interactively. 

Provides desktop notifications, interactive GUI dialogs, shell command execution, privileged command execution (sudo/su), file editing, and file/URL launching.

## 🌟 Why This Project?

**Fills a real gap** - Most MCP servers focus on APIs, databases, and cloud services. Desktop GUI integration for Linux is severely underserved. This bridges the gap between AI agents and the Linux desktop.

**Safety layer for AI agents** - The ability for an AI agent to ask for confirmation via GUI *before* running destructive commands (`rm -rf`, `dd`, etc.) is a very meaningful safety feature that doesn't exist in terminal-only workflows.

**Better UX** - Fire-and-forget notifications for long-running tasks (builds, deployments) without polluting the terminal output. The agent can inform you immediately when tasks complete.

**Universal approach** - Desktop environment detection with a fallback chain (`kdialog` → `zenity` → `notify-send`) makes it work seamlessly across KDE, GNOME, XFCE, and others. Most similar attempts are DE-specific.

**Enables human-in-the-loop workflows** - Bridges asynchronous AI agents with synchronous human decisions. The agent can now "wait" for real user input mid-execution, enabling complex workflows like:
- Run a command → analyze the output → ask the user → proceed or abort
- Propose multiple solutions → let the user choose → implement the selected option

**Token-efficient tool discovery** - Uses a `linux_system_tool_search` meta-tool so only one tool schema is loaded into the LLM context at startup. The LLM searches for tools by keyword, dramatically reducing your token usage at connection time!

---

## ⚡ Features

- **Desktop Notifications** - Fire-and-forget notifications via `notify-send`/`kdialog`/`zenity`
- **Interactive Dialogs** - A unified `ask_user` tool for Yes/No confirmations, single-choice, multi-select, text input, alerts, and password prompts
- **Shell Execution** - Run non-interactive shell commands with timeout and output capture
- **Sudo with GUI Password** - Execute privileged commands with GUI password prompts (`pkexec`/`askpass`/`su`)
- **XDG Open** - Open files, directories, or URLs in the user's default desktop application
- **Backend Stats** - Inspect which dialog/notify backends are available and their system health
- **Tool Search** - Meta-tool for efficient token-saving tool discovery
- **MCP Prompts** - Reusable prompt templates for common agent workflows
- **Universal DE Support** - Auto-detects KDE (`kdialog`) or GTK environments (`zenity`) with graceful fallbacks

---

## 🚀 Requirements

- Node.js 18+
- Any Linux desktop environment
- One of the following GUI tools:
  - `notify-send` (minimal feature set - notifications only)
  - `kdialog` (KDE - full support)
  - `zenity` (GTK/GNOME/XFCE - full support)

### Install dialog tools (Arch Linux / Manjaro)

```bash
# For KDE users
sudo pacman -S kdialog

# For GNOME/XFCE/Other GTK users
sudo pacman -S zenity
```

## 🚀 Quick Start (No Installation Required)

You can run this MCP server instantly using `npx`—no need to clone or build!

### Usage with Claude Desktop / Claude Code

Add this directly to your `claude_desktop_config.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "linux-system": {
      "command": "npx",
      "args": ["-y", "linux-system-mcp"]
    }
  }
}
```

*Note: If the package isn't published to npm yet, use `github:dgpl-mcps/linux_system_mcp` instead of `linux-system-mcp`.*

### Manual Installation (Development)

If you prefer to clone and run it locally:

```bash
git clone https://github.com/dgpl-mcps/linux_system_mcp.git
cd linux_system_mcp
npm install
npm run build
```

Then in your MCP client configuration, point to the local file:

```json
{
  "mcpServers": {
    "linux-system": {
      "command": "node",
      "args": ["/absolute/path/to/linux_system_mcp/dist/index.js"]
    }
  }
}
```

### 🧠 Token-Saving Defer Loading (default: enabled)

By default, only `linux_system_tool_search` is exposed to the LLM at connection time. The LLM **must call `linux_system_tool_search` first** to discover what tools are available before calling them. This drastically reduces token usage at startup since only one schema is loaded instead of all tool schemas.

To disable (show all tools upfront — useful for debugging):

```json
{
  "mcpServers": {
    "linux-system": {
      "command": "npx",
      "args": ["-y", "linux-system-mcp"],
      "env": {
        "defer_loading": "false"
      }
    }
  }
}
```

---

## 🛠️ Available Tools

### `linux_system_tool_search` *(meta)*
Search for available tools by keyword. Always call this first when you need a specific capability and aren't sure which tool to use.

```json
{ "query": "notification" }
```

Returns names, descriptions, and full schemas for all matching tools.

---

### `notify`
Send a fire-and-forget desktop notification. Appears in the system tray/notification area. Does **not** wait for user acknowledgement.

```json
{
  "title": "Build Complete",
  "message": "Your project has been built successfully",
  "urgency": "normal",
  "timeout": 5
}
```

Parameters:
- `urgency`: `"low"` | `"normal"` | `"critical"` (default: `"normal"`)
- `timeout`: seconds to show the notification (default: 5)

Returns: `{ "success": true, "backend": "kdialog", "method": "kdialog" }`

---

### `ask_user`
Show an interactive GUI dialog to the user and return their response. This unified tool handles all user interactions via the `op` (operation) parameter.

```json
{
  "op": "confirmation",
  "title": "Confirm Delete",
  "message": "Are you sure you want to delete these files?"
}
```

**Operations (`op`):**

- `"confirmation"`: Shows a Yes/No dialog. Blocks until user responds.
  - Returns: `{ "confirmed": true/false, "backend": "kdialog" }`
- `"choice"`: Single-selection list. `choices` parameter is required.
  - Returns: `{ "selected": "npm", "index": 0, "cancelled": false, "backend": "kdialog" }`
- `"multi_check"`: Multi-select (checkbox) dialog. `choices` parameter is required.
  - Returns: `{ "selected": ["TypeScript", "Tests"], "indices": [0, 3], "cancelled": false, "backend": "kdialog" }`
- `"input"`: Text input dialog. Supports optional `default_value`.
  - Returns: `{ "input": "myfile.txt", "cancelled": false, "backend": "kdialog" }`
- `"alert"`: OK-only alert dialog. Blocks until user dismisses it. 
  - Returns: `{ "acknowledged": true, "backend": "kdialog" }`
- `"password"`: Masked password input dialog.
  - Returns: `{ "password": "...", "cancelled": false, "backend": "kdialog" }`

**Advanced — Tool Chaining:** Use `ask_user` sequentially to create workflows. For example, ask a multiple choice question (`op: "choice"`), and if they select "Custom", follow up with a text input prompt (`op: "input"`).

---

### `shell_execute`
Execute a shell command and return stdout, stderr, and exit code. Non-interactive only. Supports pipes, redirects, and multi-command chains (`&&`, `;`).

```json
{
  "command": "df -h",
  "working_dir": "/home/user",
  "timeout": 30
}
```

Parameters:
- `working_dir`: defaults to user home directory
- `timeout`: seconds (default: 30)
- `shell`: shell binary (default: `/bin/bash`)

Returns: `{ "stdout": "...", "stderr": "", "exit_code": 0, "timed_out": false, "working_dir": "/home/user" }`

---

### `sudo_execute`
Execute a command with elevated privileges or as a specific user. Shows a GUI password dialog before running.

**Run as root with PolicyKit:**
```json
{
  "command": "pacman -Syu --noconfirm",
  "method": "pkexec",
  "timeout": 600
}
```

**Run as specific user (AUR helpers like paru/yay refuse to run as root):**
```json
{
  "command": "paru -S google-chrome --noconfirm",
  "method": "su",
  "run_as_user": "myuser",
  "timeout": 600
}
```

**Auto-detect best method:**
```json
{
  "command": "systemctl restart nginx",
  "timeout": 30
}
```

Parameters:
- `method`: Authentication method (default: `"auto"`):
  - `auto` — Smart auto-detection: picks `su` if `run_as_user` is set, `askpass` if current user is in sudoers, otherwise `pkexec`
  - `askpass` — sudo with GUI askpass prompt; requires current user to be in sudoers
  - `pkexec` — PolicyKit; shows system-level auth dialog; works for any user
  - `su` — Authenticates as the **target user** (not root); asks for *their* password
- `run_as_user`: Run the command as this user instead of root (essential for AUR helpers)
- `login_shell`: Use login shell (`-i`) to load the user's full environment (`.bashrc`, `.profile`). `askpass` method only.
- `preserve_env`: Preserve current environment variables (`-E`). `askpass` method only, cannot combine with `login_shell`.
- `nested_askpass`: Enable GUI password prompt for nested `sudo` calls inside the command. Auto-enabled for paru/yay/pikaur.
- `notify_on_error`: Send a desktop notification when the command fails with error details and a fix suggestion (default: `true`)
- `working_dir`: Working directory (default: user home, or target user's home for `su` method)
- `timeout`: Seconds (default: 120)

Returns:
```json
{
  "stdout": "...",
  "stderr": "",
  "exit_code": 0,
  "timed_out": false,
  "cancelled": false,
  "method_used": "pkexec",
  "run_as": "root"
}
```

**On failure**, also returns `error_summary`:
```json
{
  "error_summary": {
    "type": "auth_failed",
    "message": "Authentication failure",
    "context": ["su: Authentication failure"],
    "suggestion": "Wrong password entered. Try again with correct password."
  }
}
```

Error types: `auth_failed`, `not_in_sudoers`, `command_not_found`, `permission_denied`, `timeout`, `cancelled`, `unknown`

**Context notifications:** Before showing the password dialog, a desktop notification appears showing what command is about to run.

---

### `xdg_open`
Open a file, directory, or URL using the user's default desktop application. Fire-and-forget (does not wait for the app to close).

```json
{ "target": "/home/user/Downloads/report.pdf" }
```

```json
{ "target": "https://docs.example.com" }
```

Returns: `{ "success": true, "message": "Opened ... in the default desktop application." }`

---

### `get_dialog_backend_stats` *(meta)*
Inspect which dialog and notification backends are available, and their success/failure statistics. Useful for debugging when dialogs aren't appearing.

```json
{}
```

Returns:
```json
{
  "availableDialogBackends": [
    { "name": "kdialog", "available": true },
    { "name": "zenity", "available": false }
  ],
  "availableNotifyBackends": ["kdialog", "notify-send"],
  "stats": {
    "dialog": { "kdialog": { "success": 5, "failures": 0, "consecutiveFailures": 0 } },
    "notify": { "kdialog": { "success": 3, "failures": 0, "consecutiveFailures": 0 } }
  }
}
```

---

## 🎬 MCP Prompts

The server exposes two reusable prompt templates:

### `interactive_script_creation`
A prompt that guides an agent to: ask the user what the script should do, generate it with `file_edit`, and offer to run it via `shell_execute`.

### `open_workspace`
A prompt that asks the user for a directory path and opens it via `xdg_open`.

---

## 🦾 Suggested Workflows for AI Agents

### 1. System Monitoring with Alerts
```
User: "Check my disk usage and warn me if any partition is over 80%"

Agent Flow:
1. shell_execute({ command: "df -h" })
2. Parse output, find partitions over threshold
3. notify({
     title: "Disk Space Warning",
     message: "/save_data is at 81% (58G free)",
     urgency: "critical"
   })
```

### 2. Safe Destructive Operations
```
User: "Delete all .log files older than 7 days"

Agent Flow:
1. shell_execute({ command: "find /var/log -name '*.log' -mtime +7" })
2. ask_user({
     op: "confirmation",
     title: "Confirm Deletion",
     message: "Found 23 .log files older than 7 days. Delete them?"
   })
3. If confirmed → shell_execute({ command: "find ... -delete" })
4. notify({ title: "Cleanup Complete", message: "Deleted 23 log files" })
```

### 3. Interactive Package Management
```
User: "Install a code editor"

Agent Flow:
1. ask_user({
     op: "choice",
     title: "Select Editor",
     message: "Which editor do you want to install?",
     choices: ["VS Code", "Neovim", "Sublime Text", "Emacs"]
   })
2. If selected "VS Code" → shell_execute({ command: "yay -S visual-studio-code-bin" })
3. notify({ title: "Installation Complete", message: "VS Code installed successfully" })
```

### 4. Configuration with User Input
```
User: "Set up a new Git repository"

Agent Flow:
1. ask_user({
     op: "input",
     title: "Repository Name",
     message: "Enter the project name:",
     default_value: "my-project"
   })
2. shell_execute({ command: "mkdir <input> && cd <input> && git init" })
3. ask_user({
     op: "choice",
     title: "Add .gitignore?",
     message: "Select project type for .gitignore:",
     choices: ["Node.js", "Python", "Rust", "None"]
   })
4. notify({ title: "Repository Created", message: "<input> initialized with Git" })
```

### 5. Safe Config File Editing
```
User: "Change my shell prompt color"

Agent Flow:
1. shell_execute({ command: "cat ~/.bashrc | grep PS1" })
2. ask_user({
     op: "choice",
     title: "Select Color",
     message: "Choose prompt color:",
     choices: ["Green", "Blue", "Red", "Yellow"]
   })
3. (Edit ~/.bashrc manually or enable file_edit tool)
4. notify({ title: "Config Updated", message: "Restart terminal to see changes" })
```

### 6. Build & Deploy with Notifications
```
User: "Build my project and let me know when done"

Agent Flow:
1. notify({ title: "Build Started", message: "Running npm build...", urgency: "low" })
2. shell_execute({ command: "npm run build", timeout: 300 })
3. If exit_code == 0:
     notify({ title: "Build Successful", message: "Ready to deploy!", urgency: "normal" })
   Else:
     notify({ title: "Build Failed", message: "Check terminal for errors", urgency: "critical" })
     ask_user({ op: "confirmation", title: "View Logs?", message: "Open build log in editor?" })
```

### 7. Multi-Step System Administration (with sudo)
```
User: "Update my system"

Agent Flow:
1. ask_user({
     op: "confirmation",
     title: "System Update",
     message: "This will update all packages. Continue?"
   })
2. If confirmed:
     notify({ title: "Update Started", message: "Syncing repositories..." })
     sudo_execute({ command: "pacman -Syu --noconfirm", method: "pkexec", timeout: 600 })
     // User sees GUI password dialog from PolicyKit
3. If exit_code == 0:
     notify({ title: "Update Complete", message: "System is up to date" })
     ask_user({ op: "confirmation", title: "Reboot?", message: "Some updates may require a reboot." })
```

### 8. Service Management
```
User: "Restart nginx"

Agent Flow:
1. sudo_execute({ command: "systemctl status nginx" })
2. ask_user({
     op: "confirmation",
     title: "Restart Service",
     message: "nginx is running. Restart it?"
   })
3. If confirmed:
     sudo_execute({ command: "systemctl restart nginx", method: "askpass" })
     // User sees kdialog password prompt
4. notify({ title: "Service Restarted", message: "nginx is now running" })
```

### 9. AUR Package Installation (paru/yay)
```
User: "Install google-chrome from AUR"

Agent Flow:
1. ask_user({
     op: "confirmation",
     title: "AUR Installation",
     message: "Install google-chrome from AUR? This will build from source."
   })
2. If confirmed:
     notify({ title: "AUR Install", message: "Starting paru...", urgency: "low" })
     sudo_execute({
       command: "paru -S google-chrome --noconfirm",
       method: "su",
       run_as_user: "myuser",  // AUR helpers refuse to run as root
       login_shell: true,
       timeout: 600
     })
3. If exit_code == 0:
     notify({ title: "Installation Complete", message: "google-chrome installed" })
   Else:
     notify({ title: "Installation Failed", message: "Check build logs", urgency: "critical" })
```

### 10. Multi-Select Configuration
```
User: "Set up my new development environment"

Agent Flow:
1. ask_user({
     op: "multi_check",
     title: "Dev Environment Setup",
     message: "Select tools to install:",
     choices: ["Node.js", "Python", "Docker", "Git", "VS Code"]
   })
2. For each selected tool → sudo_execute({ command: "pacman -S <tool>" })
3. notify({ title: "Setup Complete", message: "Installed: Node.js, Docker, Git" })
```

### 11. Debugging Dialog Backends
```
User: "Why aren't dialogs showing up?"

Agent Flow:
1. get_dialog_backend_stats({})
2. Check availableDialogBackends for which backends are found
3. If none available → notify user that kdialog or zenity must be installed
4. ask_user({
     op: "alert",
     title: "Backend Status",
     message: "kdialog: available, zenity: not found"
   })
```

---

## 📋 Cheat Sheet: Key Patterns for Agents

| Pattern | When to Use | Tools |
|---------|-------------|-------|
| **Search First** | Don't know which tool to use | `linux_system_tool_search` |
| **Query → Notify** | System info, monitoring | `shell_execute` → `notify` |
| **Confirm → Execute** | Destructive operations | `ask_user` (`op="confirmation"`) → `shell_execute` |
| **Choose → Execute** | Multiple options available | `ask_user` (`op="choice"`) → `shell_execute` |
| **Multi-Select → Execute** | Multiple selections needed | `ask_user` (`op="multi_check"`) → `shell_execute` |
| **Input → Configure** | Custom values needed | `ask_user` (`op="input"`) → `shell_execute` |
| **Execute → Notify** | Long-running tasks | `shell_execute` → `notify` |
| **Sudo with GUI** | Privileged operations | `sudo_execute` (askpass or pkexec) |
| **Run as User** | AUR helpers (paru/yay) | `sudo_execute` with `run_as_user` |
| **Open Result** | Show user a file/URL | `xdg_open` |
| **Force Acknowledge** | Critical blocking alerts | `ask_user` (`op="alert"`) |
| **Collect Secret** | SSH/API passwords | `ask_user` (`op="password"`) |
| **Debug Backends** | Dialogs not appearing | `get_dialog_backend_stats` |

## 🏢 Credits

Powered and maintained by **[DGPL (Durbhasi Gurukulam Private Limited)](https://durbhasigurukulam.com/)** — an IT, Cybersecurity, and Edutech company.

## 📜 License

MIT License. Open-sourced for the community to make Linux the best workstation for AI Agents.
