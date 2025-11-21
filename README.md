# Linux System MCP Server

An MCP (Model Context Protocol) server for Linux desktop integration. Provides desktop notifications, interactive dialogs, shell command execution, and file editing capabilities.

## Features

- **Desktop Notifications** - Send notifications via notify-send/kdialog/zenity
- **Interactive Dialogs** - Yes/No confirmations, multiple choice, text input
- **Shell Execution** - Run non-interactive shell commands
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
cd /home/vikas/Desktop/projects/linux_system_mcp
npm install
npm run build
```

## Usage with Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "linux-system": {
      "command": "node",
      "args": ["/home/vikas/Desktop/projects/linux_system_mcp/dist/index.js"]
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
      "cwd": "/home/vikas/Desktop/projects/linux_system_mcp"
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

## Example Agent Workflow

```
User: "Check my disk usage and warn me if any partition is over 80%"

Agent Flow:
1. Call shell_execute({ command: "df -h" })
2. Parse output, find partitions over 80%
3. If found, call notify({
     title: "Disk Space Warning",
     message: "Partition /dev/sda1 is 85% full",
     urgency: "critical"
   })

User: "Delete all .log files in /var/log older than 7 days"

Agent Flow:
1. Call shell_execute({ command: "find /var/log -name '*.log' -mtime +7" })
2. Call ask_confirmation({
     title: "Confirm Deletion",
     message: "Found 23 .log files older than 7 days. Delete them?"
   })
3. If confirmed, call shell_execute({ command: "find /var/log -name '*.log' -mtime +7 -delete" })
4. Call notify({ title: "Cleanup Complete", message: "Deleted 23 log files" })
```

## License

MIT
