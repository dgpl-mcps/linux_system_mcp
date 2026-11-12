/**
 * Tool Search Engine for linux-system-mcp
 * Provides multi-term token parsing, quoted phrase preservation,
 * separate per-term searches, and aggregated structured result formatting.
 */

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TermSearchResult {
  count: number;
  tools: ToolDefinition[];
}

export interface ToolSearchSummary {
  total_terms: number;
  total_unique_matches: number;
  counts: Record<string, number>;
}

export interface ToolSearchResponse {
  summary: ToolSearchSummary;
  results: Record<string, TermSearchResult>;
}

/**
 * Tokenize a search query string into individual terms and quoted phrases.
 * Supports:
 * - Space-separated terms: `sudo shell` -> `["sudo", "shell"]`
 * - Double quotes: `"sudo shell"` -> `["sudo shell"]`
 * - Multiple quoted phrases: `"sudo1 shell1" "sudo2 shell2"` -> `["sudo1 shell1", "sudo2 shell2"]`
 * - Single quotes: `'sudo shell'` -> `["sudo shell"]`
 * - Mixed syntax: `sudo "shell execute" notify` -> `["sudo", "shell execute", "notify"]`
 * - Escaped quotes: `\"` or `\'`
 * - Graceful fallback on unclosed quotes
 */
export function parseSearchQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else {
      if (char === '"' || char === "'") {
        inQuote = char;
      } else if (/\s/.test(char)) {
        const token = current.trim();
        if (token.length > 0) {
          tokens.push(token);
          current = "";
        }
      } else {
        current += char;
      }
    }
  }

  const finalToken = current.trim();
  if (finalToken.length > 0) {
    tokens.push(finalToken);
  }

  // Deduplicate tokens case-insensitively, preserving original order and display casing
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      deduped.push(token);
    }
  }

  return deduped;
}

/**
 * Search the tool registry across parsed terms.
 * Each term is searched independently and results are aggregated into
 * a dictionary where each search term is a key with its match count and tools.
 */
export function searchTools(tools: ToolDefinition[], rawQuery: string): ToolSearchResponse {
  const terms = parseSearchQuery(rawQuery);

  if (terms.length === 0) {
    return {
      summary: {
        total_terms: 0,
        total_unique_matches: 0,
        counts: {},
      },
      results: {},
    };
  }

  const results: Record<string, TermSearchResult> = {};
  const counts: Record<string, number> = {};
  const allUniqueMatchedToolNames = new Set<string>();

  for (const term of terms) {
    const termLower = term.toLowerCase();

    // Matching logic:
    // 1. Tool name contains term (exact case-insensitive substring)
    // 2. Tool name with '_' replaced by space contains term (e.g. "shell execute" matches "shell_execute")
    // 3. Tool description contains term
    const matches = tools.filter((t) => {
      if (!t) return false;
      const name = String(t.name || "").toLowerCase();
      const nameNormalized = name.replace(/_/g, " ");
      const desc = String(t.description || "").toLowerCase();

      return (
        name.includes(termLower) ||
        nameNormalized.includes(termLower) ||
        desc.includes(termLower)
      );
    });

    for (const m of matches) {
      allUniqueMatchedToolNames.add(m.name);
    }

    counts[term] = matches.length;
    results[term] = {
      count: matches.length,
      tools: matches,
    };
  }

  return {
    summary: {
      total_terms: terms.length,
      total_unique_matches: allUniqueMatchedToolNames.size,
      counts,
    },
    results,
  };
}
