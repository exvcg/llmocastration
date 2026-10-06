---
name: agent-orchestration
description: Coordinate project coding work through LLM Co-op with configurable role-to-program assignments, durable cross-program handoffs, deterministic verification, and independent review.
---

# LLM Co-op Agent Orchestration

Use the connected Codex or Antigravity conversation as the active host. The MCP
server owns run state, resolves each role to a configured executor, preserves
handoff checkpoints when programs change, and executes only project-configured
verification commands.

Before using project tools, determine the absolute root of the workspace in the
current conversation. Pass that same `projectRoot` on every MCP tool call. Do
not reuse a project path merely because it appeared in an earlier chat.

## Workflow

1. Resolve material ambiguity before mutation; otherwise proceed with reasonable assumptions.
2. Call `initialize_project` with the absolute current workspace path. It may create `.llm-co-op/config.json`, but it must not overwrite existing project configuration.
3. Call `start_run` with the same `projectRoot`, the concrete goal, durable constraints, and observable completion criteria.
4. Call `get_next_action` before every interactive role. Follow `currentHost`, the assigned `executor`, and the handoff checkpoint.
5. If `requiresHandoff` is true, do not perform or submit that role in the current program. Tell the user which `targetExecutor` should continue the same `runId` and `projectRoot`.
6. For a locally assigned Planner or Reviewer, call `dispatch_role` and perform the returned prompt in this chat.
7. Save Planner output with `save_plan`. Every task must have explicit target files and observable acceptance criteria.
8. Call `dispatch_coder` once for each active task. It claims the task only when the current host owns the Coder role. Edit the project and call `submit_coder_result`; never report implementation success without recording the result.
9. After the run enters `verifying`, call `run_verification`. Treat command results as authoritative for build, type, lint, and test status.
10. Submit Reviewer output with `submit_review`. Evaluate the goal, acceptance criteria, actual changes, and verification result rather than relying on Coder prose. Use one verdict:
   - `pass`: requirements are met and verification passed.
   - `implementation_issue`: code must return to Coder.
   - `plan_gap`: the plan omitted or misunderstood required work.
   - `test_gap`: verification is insufficient or misconfigured.
   - `needs_human`: a product, security, or permission decision needs the user.
11. For a non-pass verdict, call `retry_run` with the matching route. Respect the configured iteration limit and stop when the run becomes blocked.
12. Call `complete_run` only after deterministic verification passed and Reviewer returned `pass`.

## Executor changes

- Use `switch_executor` with `currentStep` to retry only the active phase or selected coding task in another program.
- Use `role` to rebind one responsibility for the rest of the run.
- Use `remainingRun` to move all remaining interactive roles to another program.
- After switching, call `get_next_action` again and use its handoff. Do not reconstruct state from chat memory alone.

## Boundaries

- Keep Planner and Reviewer judgments separate even when one program performs every role.
- Always pass the current chat's absolute `projectRoot`; never depend on global mutable project state.
- Do not pass arbitrary agent-generated shell commands to verification. Use the commands returned by `get_config`.
- Do not modify files outside the configured project root.
- Preserve unrelated user changes and report any overlap that prevents a safe edit.
- Never describe a run as complete unless `complete_run` succeeds.
