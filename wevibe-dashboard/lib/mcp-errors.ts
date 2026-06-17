export const MCP_OFFLINE_CODE = 'mcp_offline';

export const MCP_OFFLINE_ERROR =
  'Local WeVibe MCP is not running (no session token at ~/.wevibe/mcp-session-token).';

export const MCP_OFFLINE_REMEDIATION =
  'Fix: fully close ALL your coding-suite instances (every OpenCode window). '
  + 'Once they are completely shut down, reopen them — this spawns a fresh local WeVibe MCP '
  + 'that writes ~/.wevibe/mcp-session-token. Then create the org again.';
