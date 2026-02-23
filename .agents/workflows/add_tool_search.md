---
description: Add tool search and defer_loading optimization to any MCP server to reduce LLM token usage at connection time
---

# Add Tool Search + Defer Loading to an MCP Server

This workflow adds Anthropic's tool search optimization pattern to any MCP TypeScript server.
Instead of injecting all tool schemas into the LLM context upfront, only a single `<prefix>_tool_search`
tool is exposed. The LLM searches for what it needs and calls tools directly by name.

---

## What You Are Implementing

1. Extract all tool definitions into a module-level `ALL_TOOLS: any[]` constant
2. Add a `<prefix>_tool_search` tool at the top of the array
3. Modify `ListToolsRequestSchema` to only return `<prefix>_tool_search` when `ENABLE_DEFER_LOADING` env var is not `false`
4. Add a `case '<prefix>_tool_search':` handler in `CallToolRequestSchema` that filters `ALL_TOOLS` by the user's query keyword

---

## Step 1 — Extract the Tools Array

Find the `ListToolsRequestSchema` handler return value. It will look like:

```typescript
this.server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: 'tool_one', ... },
      { name: 'tool_two', ... },
      // ...many more
    ],
  };
});
```

Extract the array to a module-level constant **above the class definition**:

```typescript
// At the top of the file, after imports
const ALL_TOOLS: any[] = [
  { name: 'tool_one', ... },
  { name: 'tool_two', ... },
  // ... all original tools
];

// Inject the search tool at the beginning (it must NOT be deferred)
ALL_TOOLS.unshift({
  name: '<PREFIX>_tool_search',
  description: '[meta] Search for available tools by keyword. Use this when you need a specific capability. Returns names, descriptions and full schemas for matching tools.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword to search for in tool names and descriptions' },
    },
    required: ['query'],
  },
});
```

Replace `<PREFIX>` with your server's tool prefix (e.g. `ssh`, `fs`, `browser`, etc.).

---

## Step 2 — Update ListToolsRequestSchema Handler

Replace the old handler with this pattern:

```typescript
this.server.setRequestHandler(ListToolsRequestSchema, async () => {
  // When ENABLE_DEFER_LOADING is active (default), only expose <PREFIX>_tool_search.
  // LLM must call tool_search to discover other tools, saving massive token usage.
  // Set ENABLE_DEFER_LOADING=false to expose all tools upfront.
  const enableDeferLoading = process.env.ENABLE_DEFER_LOADING !== 'false';

  const tools = enableDeferLoading
    ? ALL_TOOLS.filter(t => t.name === '<PREFIX>_tool_search')
    : ALL_TOOLS;

  return { tools };
});
```

---

## Step 3 — Add Tool Search Handler in CallToolRequestSchema

Inside the `switch (name) {` block in `CallToolRequestSchema`, add this **before** the `default:` case:

```typescript
case '<PREFIX>_tool_search': {
  const query = String(args.query || '').toLowerCase();

  const results = ALL_TOOLS.filter((t: any) =>
    t.name.toLowerCase().includes(query) ||
    (t.description && t.description.toLowerCase().includes(query))
  );

  if (results.length === 0) {
    return {
      content: [{ type: 'text', text: `No tools found matching '${query}'. Try a broader keyword.` }]
    };
  }

  const formatted = results.map((t: any) =>
    `--- Tool: ${t.name} ---\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.inputSchema, null, 2)}`
  ).join('\n\n');

  return {
    content: [{ type: 'text', text: `Found ${results.length} matching tools:\n\n${formatted}` }]
  };
}
```

---

## Step 4 — Ensure prompts capability is declared (if server uses prompts)

In the `new Server(...)` constructor options, make sure `prompts` is listed:

```typescript
this.server = new Server(
  { name: 'my-server', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      prompts: {}, // add this if you use ListPromptsRequestSchema or GetPromptRequestSchema
    },
  }
);
```

---

## Step 5 — Build and Test

```bash
npm run build
```

Test that only the search tool is listed:

```bash
node << 'EOF'
const { spawn } = require('child_process');
const server = spawn('node', ['dist/your-server.js']);
let buf = '';
server.stdout.on('data', d => {
  buf += d.toString();
  try {
    const msgs = buf.split('\n').filter(l => l.trim().startsWith('{'));
    for (const m of msgs) {
      const msg = JSON.parse(m);
      if (msg.id === 1) {
        console.log('Tools returned:', msg.result.tools.map(t => t.name));
        server.kill(); process.exit(0);
      }
    }
  } catch(e) {}
});
setTimeout(() => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n'), 500);
setTimeout(() => { server.kill(); process.exit(1); }, 3000);
EOF
```

Expected output (with ENABLE_DEFER_LOADING=true default):
```
Tools returned: [ '<PREFIX>_tool_search' ]
```

---

## MCP Client Config

```json
{
  "mcpServers": {
    "your_server": {
      "command": "node",
      "args": ["/absolute/path/to/dist/your-server.js"],
      "env": {
        "ENABLE_DEFER_LOADING": "true"
      }
    }
  }
}
```

Set `"ENABLE_DEFER_LOADING": "false"` to disable and show all tools upfront (useful for debugging or non-optimized clients).
