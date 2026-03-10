# Linux System MCP Server

An MCP (Model Context Protocol) server for Linux desktop integration. Provides desktop notifications, interactive dialogs, shell command execution, and file editing capabilities.

## Why This Project?

**Fills a real gap** - Most MCP servers focus on APIs, databases, and cloud services. Desktop GUI integration for Linux is underserved. This bridges the gap between AI agents and the Linux desktop.

**Safety layer for AI agents** - The ability for an AI agent to ask for confirmation via GUI *before* running destructive commands (`rm -rf`, `dd`, etc.) is a meaningful safety feature that doesn't exist in terminal-only workflows.

**Better UX** - Notifications for long-running tasks (builds, deployments) without polluting the terminal output. The agent can inform you when tasks complete.

**Universal approach** - Desktop environment detection with fallback chain (kdialog → zenity → notify-send) makes it work across KDE, GNOME, XFCE, and others. Most similar attempts are DE-specific.

**Enables human-in-the-loop workflows** - Bridges async AI agents with synchronous human decisions. The agent can now "wait" for real user input mid-execution, enabling complex workflows:
- Run command → analyze output → ask user → proceed or abort
- Propose multiple solutions → let user choose → implement selected option

## Features

- **Desktop Notifications** - Send notifications via notify-send/kdialog/zenity
- **Interactive Dialogs** - Yes/No confirmations, multiple choice, text input
- **Shell Execution** - Run non-interactive shell commands
- **Sudo with GUI Password** - Execute privileged commands with GUI password prompts
- **File Editing** - Replace, insert, append, delete with regex support
- **Universal DE Support** - Auto-detects KDE (kdialog) or GTK environments (zenity)

## Requirements

- Node.js 18+
- Linux desktop environment
- One of:
  - `notify-send` (minimal - notifications only)
  - `kdialog` (KDE - full support)
  - `zenity` (GTK/GNOME/XFCE - full support)

### Install dialog tools (Arch Linux)

```bash
# For KDE
sudo pacman -S kdialog

# For GNOME/XFCE/Others
sudo pacman -S zenity
```

## Installation

```bash
git clone https://github.com/dgpl-mcps/linux_system_mcp.git
cd linux_system_mcp
npm install
npm run build
```

## Usage with Claude Code

Add to your `~/.claude/settings.json` (replace `/path/to` with actual path):

```json
{
  "mcpServers": {
    "linux-system": {
      "command": "node",
      "args": ["/path/to/linux_system_mcp/dist/index.js"]
    }
  }
}
```

Or for project-specific `.mcp.json`:

```json
{
  "mcpServers": {
    "linux-system": {
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": "/path/to/linux_system_mcp"
    }
  }
}
```

## Available Tools

### `notify`
Send a desktop notification.

```json
{
  "title": "Build Complete",
  "message": "Your project has been built successfully",
  "urgency": "normal",
  "timeout": 5
}
```

### `ask_confirmation`
Show Yes/No dialog and get user response.

```json
{
  "title": "Confirm Delete",
  "message": "Are you sure you want to delete these files?"
}
```

Returns: `{ "confirmed": true/false }`

### `ask_choice`
Show multiple choice dialog.

```json
{
  "title": "Select Package Manager",
  "message": "Which package manager should we use?",
  "choices": ["npm", "yarn", "pnpm", "bun"]
}
```

Returns: `{ "selected": "npm", "index": 0, "cancelled": false }`

### `ask_input`
Show text input dialog.

```json
{
  "title": "Enter Filename",
  "message": "What should the new file be named?",
  "default_value": "untitled.txt"
}
```

Returns: `{ "input": "myfile.txt", "cancelled": false }`

### `shell_execute`
Execute a shell command.

```json
{
  "command": "free -h",
  "working_dir": "/home/user",
  "timeout": 30
}
```

Returns: `{ "stdout": "...", "stderr": "", "exit_code": 0, "timed_out": false }`

### `sudo_execute`
Execute a command with elevated privileges or as a specific user. Shows GUI password dialog.

**Run as root:**
```json
{
  "command": "pacman -Syu",
  "method": "pkexec",
  "timeout": 120
}
```

**Run as specific user (for yay/paru/makepkg):**
```json
{
  "command": "paru -S some-package",
  "method": "su",
  "run_as_user": "superuser"
}
```

**Using `su` method (asks for target user's password):**
```json
{
  "command": "paru -Syu",
  "method": "su",
  "run_as_user": "superuser",
  "timeout": 300
}
```
This is ideal when the MCP server runs as a non-sudoer user but you need to run commands as a different user who has sudo privileges.

Parameters:
- `method`: Authentication method:
  - `auto` (default): **Smart auto-detection** - picks best method automatically:
    - If `run_as_user` specified → uses `su` (asks their password)
    - If current user can sudo → uses `askpass`
    - Otherwise → uses `pkexec`
  - `askpass`: sudo with GUI prompt - requires current user in sudoers
  - `pkexec`: PolicyKit - always asks for root/admin password
  - `su`: Direct user switch - asks for **target user's password**
- `run_as_user`: Run as this user instead of root (essential for AUR helpers)
- `login_shell`: Load user's full environment (.bashrc, .profile)
- `preserve_env`: Keep current environment variables (DISPLAY, PATH)
- `nested_askpass`: Enable GUI password prompt for nested sudo calls (auto-enabled for paru/yay)
- `notify_on_error`: Send desktop notification on errors with details (default: true)

Returns: `{ "stdout": "...", "stderr": "", "exit_code": 0, "cancelled": false, "method_used": "pkexec", "run_as": "vikas" }`

**Context notifications:** Before showing password dialog:
- Desktop notification shows what command is about to run
- Password dialog displays the command being executed

**Error handling:** On failure, returns `error_summary` with:
- `type`: `auth_failed`, `not_in_sudoers`, `command_not_found`, `permission_denied`, `timeout`, `cancelled`, `unknown`
- `message`: The error message
- `context`: 5 lines around the error for debugging
- `suggestion`: Helpful fix suggestion

### `file_edit`
Edit a file with various operations.

```json
{
  "file_path": "/path/to/file.txt",
  "operation": "replace",
  "pattern": "old_text",
  "replacement": "new_text",
  "create_backup": true
}
```

Operations: `replace`, `replace_all`, `insert_after`, `insert_before`, `append`, `prepend`, `delete_line`, `delete_pattern`

## Suggested Workflows for AI Agents

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
2. ask_confirmation({
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
1. ask_choice({
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
1. ask_input({
     title: "Repository Name",
     message: "Enter the project name:",
     default_value: "my-project"
   })
2. shell_execute({ command: "mkdir <input> && cd <input> && git init" })
3. ask_choice({
     title: "Add .gitignore?",
     message: "Select project type for .gitignore:",
     choices: ["Node.js", "Python", "Rust", "None"]
   })
4. If selected → file_edit({ operation: "append", content: "<gitignore template>" })
5. notify({ title: "Repository Created", message: "<input> initialized with Git" })
```

### 5. Safe Config File Editing
```
User: "Change my shell prompt color"

Agent Flow:
1. shell_execute({ command: "cat ~/.bashrc | grep PS1" })
2. ask_choice({
     title: "Select Color",
     message: "Choose prompt color:",
     choices: ["Green", "Blue", "Red", "Yellow"]
   })
3. file_edit({
     file_path: "~/.bashrc",
     operation: "replace",
     pattern: "PS1=.*",
     replacement: "PS1='\\[\\e[32m\\]\\u@\\h:\\w\\$ \\[\\e[0m\\]'",
     create_backup: true
   })
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
     ask_confirmation({ title: "View Logs?", message: "Open build log in editor?" })
```

### 7. Multi-Step System Administration (with sudo)
```
User: "Update my system"

Agent Flow:
1. ask_confirmation({
     title: "System Update",
     message: "This will update all packages. Continue?"
   })
2. If confirmed:
     notify({ title: "Update Started", message: "Syncing repositories..." })
     sudo_execute({ command: "pacman -Syu --noconfirm", method: "pkexec", timeout: 600 })
     // User sees GUI password dialog from PolicyKit
3. If exit_code == 0:
     notify({ title: "Update Complete", message: "System is up to date" })
     ask_confirmation({ title: "Reboot?", message: "Some updates may require a reboot." })
```

### 8. Service Management
```
User: "Restart nginx"

Agent Flow:
1. sudo_execute({ command: "systemctl status nginx" })
2. ask_confirmation({
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
1. ask_confirmation({
     title: "AUR Installation",
     message: "Install google-chrome from AUR? This will build from source."
   })
2. If confirmed:
     notify({ title: "AUR Install", message: "Starting paru...", urgency: "low" })
     sudo_execute({
       command: "paru -S google-chrome --noconfirm",
       method: "pkexec",
       run_as_user: "vikas",  // IMPORTANT: AUR helpers refuse to run as root
       login_shell: true,
       timeout: 600
     })
3. If exit_code == 0:
     notify({ title: "Installation Complete", message: "google-chrome installed" })
   Else:
     notify({ title: "Installation Failed", message: "Check build logs", urgency: "critical" })
```

### Key Patterns for Agents

| Pattern | When to Use | Tools |
|---------|-------------|-------|
| **Query → Notify** | System info, monitoring | `shell_execute` → `notify` |
| **Confirm → Execute** | Destructive operations | `ask_confirmation` → `shell_execute` |
| **Choose → Execute** | Multiple options available | `ask_choice` → `shell_execute` |
| **Input → Configure** | Custom values needed | `ask_input` → `file_edit` |
| **Execute → Notify** | Long-running tasks | `shell_execute` → `notify` |
| **Backup → Edit** | Config file changes | `file_edit` with `create_backup: true` |
| **Sudo with GUI** | Privileged operations | `sudo_execute` (askpass or pkexec) |
| **Run as User** | AUR helpers (paru/yay) | `sudo_execute` with `run_as_user` |

## License

MIT
