# Orchestrator

Open **Settings → Orchestrator** to configure routing. The chat's **Manual / Auto / One model** control changes the current project's mode and priority; detailed settings can apply to one project or the environment.

- **Manual** uses the model picker.
- **Auto** sends each task to the enabled route whose phrases it mentions most; earlier routes win ties. The route sets the provider (Claude, Codex, Grok, Kimi, Muse or any other connected provider), model, and priority-specific effort. **Everything else** decides what unmatched tasks use: keep the current model or pick one. **Test a task** shows where a sample request would go before you send it. These are explicit preferences, not live benchmark rankings or a learned task classifier.
- **One model** locks tasks, delegated agents, and background writing to the selected model. An unavailable locked model fails visibly rather than using another subscription. Providers without background-writing support cannot generate automatic titles or Git text in this mode.

**Add route** offers starting points: Design & frontend (Claude Opus 5.5), Backend & agentic and Tests & debugging (GPT-6 Astra), and Research & answers (Grok when connected). Edit phrases, models and the **Use for** description, which delegating agents read when choosing a specialist. Balanced and Thorough start at high effort; neither automatically selects maximum. Only efforts reported by the provider are offered. A fallback is used only when explicitly configured and the primary is unavailable before dispatch; a running task is never silently retried on another provider.

**Direct** keeps work with the assigned agent. Optional delegation gives the parent an `agent_task` tool to start, inspect, and stop scoped workers across providers. Configure concurrency, agents per task, nesting depth, file ownership, and additional instructions. Workers appear as ordinary saved conversations. Stopping the parent stops its descendants; deleting it deletes their conversations. File ownership prevents overlapping assignments but is not a filesystem sandbox. Native provider subagents are instructed to use this tool so model locks and limits apply.

**Combine queued messages** sends compatible pending messages together when the current response ends, including their attachments and context. Messages held after a failure still require Send now. Stop retains unsent work for review. Pending queues remain local to the open client, so send or recover them before reloading it.

## Kimi Code and Muse subscriptions

Install and log in to the provider's own CLI first, then use **Settings → Providers → Add provider**. Choose Kimi Code or Muse and set its executable path if it is not on PATH. T3 uses the existing CLI login; it does not copy credentials into conversation handoffs.

Kimi reads its model catalogue without creating a session. It supports streamed responses, permission prompts, cancellation, and native session resumption. Queued messages wait until its current response ends.

Muse uses the installed CLI's headless execution because its interactive server does not yet provide a working event subscription. Each turn receives the saved T3 conversation. Use **Plan** for analysis or explicitly choose **Full access** for execution; interactive approval prompts are unsupported. Responses appear when the run finishes. T3 MCP delegation and background writing are unavailable through this headless interface, so use Muse as a direct worker. Native session logs are disabled; temporary prompts are removed after completion or cancellation.

T3 retains one private conversation handoff per thread and removes it when that thread is deleted. Kimi and other providers can retain their own native histories; T3 leaves those intact because other apps may use them.
