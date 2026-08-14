# @hjqcan/tachikoma-cli

The only Tachikoma executable package. `tachikoma` and `tachikoma chat` open the same REPL;
`tachikoma run <prompt>` is a one-shot facade over the same Core `ChatSession`.

GoodMemory is enabled by default. Use `--no-memory` to disable it explicitly. Credentials are owned
by pi `ModelRuntime` and are never accepted as command-line flags.
