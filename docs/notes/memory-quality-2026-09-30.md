# Offline memory-quality investigation

## Reproducible setup

Starting Tachikoma revision: `fd7a8bdf1de32c376468dcf3844fe9a247675fea`, originally pinned to
GoodMemory 0.7.5. Baseline and published GoodMemory 0.8.0 were exercised through the actual
`ChatEngine`, runtime-kit, temporary SQLite, a fresh query session, and the model's actual input.
Only the final chat provider was replaced by pi's deterministic faux provider. Credentials were
poisoned and the offline network guard was enabled. No production data or paid model was used.

The existing 15 memory tests passed, but did not cover the following failures. The 19-case
`bun run eval:memory` diagnostic records input, profile, stored facts, recall context, and memory
status events. Its checks test desired memory behavior, not merely successful chat completion. The
fixtures are deliberately adversarial; their pass fraction is not a general accuracy estimate.

## Confirmed semantic failures in the published package

- Quoted fiction: `小说里的人物说：“我的名字是夏雨”。这不是我的名字。` becomes the user's profile
  name `夏雨”` and is injected in the next session
- Attribution: `My friend said "My name is Alice." My name is Bob.` recalls Alice as the user's name
- Correction: an initial Python backend preference survives
  `I no longer prefer Python. I now prefer Go for backend services.` and is still injected as
  current
- Omission and relevance: `请记住，项目甲使用 PostgreSQL；项目乙使用 SQLite。` stores only the first
  fact; asking about project 乙 receives the PostgreSQL fact for project 甲
- Hypotheticals: a conditional coffee example can become an actual `response_style` preference
- Other coverage gaps include negative preferences, paraphrased drink recall, relocation, pronoun
  follow-ups, and incomplete long-term response-language preferences

Controls prevent counting abstention as universal failure: direct name recall and name correction
work, and the tested uncertain English hypothetical, uncertain Chinese role, and assistant-only
invented identity do not become recalled facts under the default deterministic extractor.

The host sends only the current user message and assistant response to runtime-kit. It must not
invent a pronoun's referent or rewrite unsupported memory facts to make these tests pass.
Extraction, correction, and source attribution belong in GoodMemory; the host-level fixes below do
not claim to resolve those semantic failures. Live-model extraction and final answers were not
evaluated.

## Host-level fixes in this change

1. Recall is ephemeral model context. Earlier hidden snapshots no longer accumulate in the
   transcript. Legacy raw snapshots are removed from normal model context and compaction input.
   Durable deletion therefore stops injecting that snapshot in the next call. Already-written user
   messages, assistant answers, and earlier summaries are not erased
2. User profiles are visible in memory management and explicitly deletable. Workspace clear retains
   the user-wide shared profile and other scopes; its UI label now states that boundary. Profile
   deletion rejects another user's synthetic profile ID and ambiguous cross-kind ID collisions
3. Writeback carries the user turn's stable source ID and receipt timestamp. Optional explicit user
   IANA timezone, or GoodMemory's remembered profile timezone, anchors relative dates. An event
   `Yesterday I moved to Paris. Remember that.` with `Asia/Shanghai` now stores an absolute
   local-day interval with original evidence and the source message ID
4. The dependency and packed-consumer checks target published `goodmemory@0.8.0`

`memory-integrity.test.ts` covers these integration behaviors with real SQLite and offline faux
chat. The broader quality diagnostic remains red until its semantic expectations genuinely pass. Do
not replace those expectations with the observed wrong values or claim unpublished GoodMemory source
changes are present in the pinned npm artifact.

## Validation and release limits

The reviewed source checkpoint passes format, lint, typecheck, all workspace builds, 194 offline
regression tests (798 assertions), and five built-CLI package tests (26 assertions). Clean tarball
installation, Node/Bun imports, executable/shebang checks, and CLI help/version checks pass, but
`test:pack` remains **failed** at its final consumer audit. Root `bun audit` also fails. Neither
audit was disabled, waived in code, or replaced by an override in the test consumer.

The clean consumer reports 11 advisories (2 high, 5 moderate, 4 low); the locked development
workspace reports 28 (10 high, 11 moderate, 7 low). The existing hard pins are:

- GoodMemory 0.7.5 and 0.8.0 both bring AI SDK provider-utils 4.0.21/4.0.23 through their pinned
  dependencies. The
  [resource-consumption advisory](https://github.com/advisories/GHSA-866g-f22w-33x8) requires 4.0.33
  or later on the 4.x line
- Unchanged pi-coding-agent 0.84.2 pins undici 8.9.0. Its high-severity
  [WebSocket handshake denial of service](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) and
  [BalancedPool TLS-validation issue](https://github.com/advisories/GHSA-w293-vg96-wgc3), plus other
  advisories, are patched in 8.10.2
- The existing development lock also contains affected Electron 43.4.0, brace-expansion 5.0.9, and
  the Electron downloader's undici 7.x dependency

Static reachability review found no new HTTP/WebSocket/TLS call sites in this change, no
BalancedPool call in Tachikoma/pi, and no Tachikoma call to pi's `configureHttpDispatcher` global
installer. Under canonical Bun, pi's Codex WebSocket path uses the Bun global WebSocket. This is not
a general non-exploitability claim: alternate runtimes, consumers, and other installed paths remain
unproven, and the dependency audit stays red.

This is a source checkpoint, not a release or a claim that all verification gates pass. Upstream
compatible dependency updates and a later published GoodMemory artifact are needed for the default
clean consumer to receive those fixes. The semantic diagnostic is separately **6/19**, with 13 unmet
expectations still recorded. No npm publication, deployment, or real-model validation is part of
this checkpoint.
