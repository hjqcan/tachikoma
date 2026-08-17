# ACP adapter (spike)

`tachikoma-acp` (`packages/server/src/acp.ts`) speaks the
[Agent Client Protocol](https://agentclientprotocol.com) v1 over stdio, so ACP editors (Zed,
JetBrains) can drive Tachikoma as an agent subprocess. It wraps `ChatEngine` in-process — the
engined sidecar's RPC+WS face is unrelated to ACP's process model, and ACP wire shapes stay out of
`@hjqcan/tachikoma-protocol`.

Supported: fresh sessions (`session/new` with the editor's cwd as workspace grant), text-only
prompts, streamed answer/thought chunks, tool-call updates, approvals via
`session/request_permission` (allow once / allow for session / deny), and `session/cancel`.
Deliberately absent: `session/load`, client fs/terminal capabilities, MCP passthrough, images.
Approvals are out-of-band: the event pump never blocks on the editor's answer; the engine's own
approval timeout and abort remain the backstop, and late answers are ignored safely.

## Zed setup

```json
{
  "agent_servers": {
    "tachikoma": {
      "command": "bun",
      "args": ["/path/to/tachikoma/packages/server/src/acp.ts", "--toolset", "coding"],
      "env": {
        "TACHIKOMA_PROVIDER": "openai",
        "TACHIKOMA_MODEL": "gpt-5.2"
      }
    }
  }
}
```

Add `TACHIKOMA_CONFIG_DIR` for custom `models.json` providers, `TACHIKOMA_DATA_DIR` to relocate
transcripts. Memory is off in the spike.

## Manual acceptance

1. Open the agent panel, pick `tachikoma`, send a message — the answer streams token by token.
2. Ask it to create a file — Zed shows the permission prompt; Allow creates the file, Deny does not
   and the model reports the denial.
3. Press stop mid-turn — the prompt ends with `stopReason: "cancelled"`.

The offline end-to-end check for the same flow is `packages/server/tests/acp-smoke.test.ts` (spawns
the real bin with a faux model preload).
