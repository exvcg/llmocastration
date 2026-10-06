# Codex personal installation files

Run `npm run plugin:build` first. The build copies the self-contained MCP runtime to
`plugin/llm-co-op-agent/dist/mcp/server.mjs`.

Install manually:

1. Copy `plugin/llm-co-op-agent` to
   `%USERPROFILE%/.codex/plugins/llm-co-op-agent`.
2. Merge `marketplace.json` into
   `%USERPROFILE%/.agents/plugins/marketplace.json`.
3. Install **LLM Co-op Agent** from the **LLM Co-op Personal** source in the
   Plugins Directory.
4. Use `config.toml` as the user-level enablement block if the plugin browser
   did not add it automatically.
5. Restart Codex and start a new chat.

The templates are intentionally stored in the repository. Building the project
does not modify the user profile.
