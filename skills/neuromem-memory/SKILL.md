---
name: neuromem-memory
description: Record and recall source-grounded project memory through Neuromem MCP, especially when an agent must recover prior decisions, facts, evidence, Wiki context, or relationships without a memory-side chat model.
---

# Neuromem Memory

Use Neuromem as an evidence store, not as an answer generator. The calling agent remains responsible for interpretation and the final answer.

## Recall

- Use the Workspace and Project scope supplied by the current project profile. Do not guess UUIDs or silently switch scope.
- Start with `recall` for an ordinary memory question. Use `search_records` for exact wording or raw events and `search_claims` for compact assertions.
- When a Claim affects the answer, call `get_claim_evidence`. Use `get_record_context` when the surrounding exchange can change its meaning.
- Use `wiki_read` for a project-level current view and `graph_read` only when relationships matter.
- Treat a Claim as an assertion derived from a Record, not as unquestionable truth. Preserve `origin_node`, surface conflicts, and cite the supporting Record IDs.
- If evidence is insufficient, say what is missing. Do not fill the gap with background knowledge and present it as remembered fact.

For a broad or ambiguous recall task, delegate the searches to a subagent when the host supports subagents. Ask it to return a compact evidence packet—relevant Claims, Record IDs, origin Nodes, conflicts, and unresolved gaps—so raw search results do not fill the main context.

## Record

- Call `memory_record` once per source event with the actual human or Agent author. Do not relabel an Agent statement as a user statement.
- Supply a stable `idempotency_key` derived from the source session and event/message ID. Reuse it when retrying an ambiguous call.
- Exclude system prompts, scheduler output, and automation noise. Record tool output only when it was intentionally submitted as a `tool_result` Record.
- Keep Personal and Company routing explicit. Use `target: both` only when the configured Router has valid scope mappings for both Nodes.

Do not look for or emulate a memory-side `chat()` tool. Synthesize the answer from the bounded structured results and their evidence.
