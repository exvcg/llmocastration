# LLM Co-op

LLM Co-op coordinates one development run across interactive programs such as
Codex and Google Antigravity. A personal MCP plugin can serve multiple projects;
durable run state and verification data remain isolated under each selected
project root.

## Architecture

```text
Codex plugin (host=codex) ─────────┐
                                   ├─ LLM Co-op MCP server
Antigravity plugin                 │    ├─ Role → executor resolution
  (host=antigravity) ──────────────┘    ├─ Cross-program handoff
                                        ├─ Run and task state
                                        └─ Deterministic verification

VSCode extension
  └─ Future status and approval UI entry point
```

Runtime data is stored under `.llm-co-op/`:

- `config.json`: executor registry, role bindings, commands, and limits
- `task.json`: implementation tasks
- `runs.json`: workflow state and executor switches
- `history.json`: workflow events

## Build

```powershell
npm install
npm run compile
```

For the installable personal plugin bundle, use:

```powershell
npm run plugin:build
```

The build produces:

- `dist/extension.js`
- `dist/mcp/server.mjs`
- `plugin/llm-co-op-agent/dist/mcp/server.mjs` (self-contained plugin runtime)

## MCP server

Every MCP client identifies itself with `LLM_CO_OP_HOST` or `--host`. A fixed
project root is optional and remains available only for backwards-compatible
development launches:

```powershell
node dist/mcp/server.mjs `
  --project-root C:\Users\gnex0\Desktop\llmocastration `
  --host codex
```

The Codex personal-plugin source is located at `plugin/llm-co-op-agent`:

- Codex manifest: `.codex-plugin/plugin.json`
- Codex MCP config: `.mcp.json`
- Bundled runtime: `dist/mcp/server.mjs`
- Shared workflow instructions: `skills/agent-orchestration/SKILL.md`

The Antigravity-specific files are kept separately under
`adapters/antigravity/llm-co-op-agent` so its root `plugin.json` cannot be
mistaken for the portable Codex manifest.

## Personal Codex installation

The repository prepares the plugin but does not write to the user profile.
After building:

1. Copy `plugin/llm-co-op-agent` to
   `%USERPROFILE%/.codex/plugins/llm-co-op-agent`.
2. Merge `distribution/codex-personal/marketplace.json` into
   `%USERPROFILE%/.agents/plugins/marketplace.json`.
3. Restart Codex, open the Plugins Directory, select **LLM Co-op Personal**,
   and install **LLM Co-op Agent**.
4. Start a new chat in a project and let the skill call `initialize_project`
   with that chat's absolute workspace path.

The personal plugin is visible across new chats. Every project tool accepts a
`projectRoot`, so concurrent chats do not share mutable global project state.

## Configuration

Missing settings receive safe defaults. Create or edit
`.llm-co-op/config.json` to override them. Verification commands are
file-owned and cannot be replaced through the MCP tool.

```json
{
  "defaultExecutor": "codex",
  "executors": {
    "codex": {
      "type": "interactive"
    },
    "antigravity": {
      "type": "interactive"
    }
  },
  "roles": {
    "planner": {
      "executor": "default",
      "instructions": "목표를 구현 가능한 작업과 완료 조건으로 분해합니다."
    },
    "coder": {
      "executor": "antigravity",
      "instructions": "계획과 완료 조건에 따라 프로젝트를 수정합니다."
    },
    "verifier": {
      "executor": "command",
      "commands": [
        "npm run check-types",
        "npm run lint"
      ]
    },
    "reviewer": {
      "executor": "default",
      "instructions": "목표, diff, 테스트 결과만으로 독립 검토합니다."
    }
  },
  "limits": {
    "maxIterations": 3,
    "timeoutSeconds": 600
  }
}
```

`default` means the role follows `defaultExecutor`. A run snapshots the role
bindings when it starts. `switch_executor` can then reroute work without losing
state:

- `currentStep`: only the active phase or selected coding task
- `role`: the selected role for the rest of the run
- `remainingRun`: every remaining interactive role

The MCP server never starts Codex, Antigravity, or Gemini as a child model
process. If the assigned executor differs from the connected host,
`get_next_action` and the dispatch tools return `requiresHandoff` plus a durable
checkpoint. Open the target program and continue the same `runId` there.

## Agent workflow

1. `initialize_project(projectRoot)` creates missing project-local defaults.
2. `start_run(projectRoot, ...)` snapshots executor assignments.
3. `get_next_action` resolves the active role and assigned executor.
4. If `requiresHandoff` is true, continue the same `runId` and `projectRoot` in
   `targetExecutor`.
5. `dispatch_role` prepares local Planner or Reviewer work.
6. `save_plan` records Planner output.
7. `dispatch_coder` claims a task only on the assigned executor.
8. The host edits files and calls `submit_coder_result`.
9. `run_verification` executes configured commands.
10. `submit_review`, then `retry_run` or `complete_run`.

The server rejects plan, coder, and review submissions from a host that does not
own the corresponding role. Mutating MCP tools still use each client's approval
policy.

Legacy model-based config and run records are migrated in memory: `gemini` and
`gemini-cli` assignments become `antigravity` executor assignments when read.
