# Named presets

A preset is a named session composition stored as data: `<configDir>/presets/<name>.json`. It
bundles what today takes several flags — system prompt, skills, toolset, workspace, model, thinking
level — into one deliberate choice. The open repo ships the mechanism only; verticals ship preset
content (prompt files, skill directories) beside the JSON and never appear in this codebase.

```json
{
  "systemPromptFile": "./review.prompt.md",
  "skills": ["./skills/checklist", "./skills/style-guide"],
  "toolset": "coding",
  "workDir": "/path/to/project",
  "model": { "provider": "openai", "model": "gpt-5.2" },
  "thinkingLevel": "medium",
  "memory": false
}
```

All fields are optional; unknown keys are rejected. Relative paths resolve against the preset file's
directory, so a preset directory is a relocatable bundle. Resolution is fail-loud at the edge that
loads it: a missing preset lists available names, the prompt file is read immediately (empty or
unreadable throws), every skill path and the workDir must exist. `memory` accepts only `false` —
identity and database path are deployment concerns, not composition. No `$ENV` interpolation:
presets carry no secrets (credentials stay with `models.json` / pi).

Consumers and merge order (one shared implementation, `mergePresetConfig` in core, used by both
edges): explicit flags / `TACHIKOMA_*` variables override preset fields. Setting `TACHIKOMA_SKILLS`
to an empty string is an explicit clear — it suppresses the preset's skills rather than falling back
to them. Invalid explicit values never fall through to the preset: a bad `TACHIKOMA_TOOLSET` or a
half-set `TACHIKOMA_PROVIDER`/`TACHIKOMA_MODEL` pair fails startup.

- CLI: `tachikoma --preset <name>` (configDir = `TACHIKOMA_CONFIG_DIR` → `TACHIKOMA_DATA_DIR` →
  `~/.tachikoma`).
- engined: `TACHIKOMA_PRESET=<name>` — resolution failure fails startup, and the preset's
  workDir/toolset/skills also feed `engine.hello`'s session defaults.

Cross-field checks run after the merge, so a preset's `workDir` satisfies flag-supplied `--skills`
and vice versa. `ChatEngine` itself never sees presets — `resolvePreset` in
`packages/core/src/chat/presets.ts` is a pure function the edges call.

Deliberately absent: preset inheritance, per-session presets over RPC (a future append-only
`params.preset` + capability if ever needed), and preset management commands.
