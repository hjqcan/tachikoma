# @hjqcan/tachikoma-server

`tachikoma-engined` — the local sidecar that hosts one Tachikoma `ChatEngine` on `127.0.0.1` for
remote consumers (desktop shells and other local apps). HTTP `POST /v1/rpc` carries the RPC
envelope; WebSocket subscribers replay each session's WAL from any `fromSeq` before live frames. The
supervising shell injects a Bearer token as the first stdin line and reads one `listening` JSON line
from stdout; engine configuration comes from shell-controlled `TACHIKOMA_*` env.

Requires Bun at runtime (`bun >= 1.3.14`); `build:bin` compiles a self-contained binary. Clients
speak only [`@hjqcan/tachikoma-protocol`](https://www.npmjs.com/package/@hjqcan/tachikoma-protocol).

Part of [Tachikoma](https://github.com/hjqcan/tachikoma). MIT licensed.
