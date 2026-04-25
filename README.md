# Claude systemd

Read-only systemd inspection for [Claude Desktop](https://claude.ai/download) on Linux. Lets Claude answer the most common Linux ops question — _"why is this service broken?"_ — without you copy-pasting `systemctl` and `journalctl` output by hand.

Seven tools cover unit listing, per-unit status, journal tailing, failed-unit hunting, unit-property inspection, raw unit-file display (including drop-in overrides), and queued-job inspection.

**Strictly read-only in v0.1.** No `restart`, `enable`, `disable`, or `daemon-reload`. Safe to enable on production hosts and shared systems. If you want destructive control, run those commands manually via [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp).

## Requirements

- Linux with systemd (any modern Ubuntu/Debian/Fedora/Arch).
- `systemctl` and `journalctl` on `PATH` (standard with systemd).
- Read access to the journal for the units you care about. By default, system-wide journal access requires being in the `systemd-journal` or `adm` group; user-scope journals are always readable by their owner.

## Install (Claude Desktop)

1. Download the latest `Systemd.mcpb` from the [Releases](https://github.com/LukeLamb/claude-systemd-mcp/releases) page.
2. **Settings → Extensions → Extension Developer → Install Extension** → pick the `.mcpb`.
3. Enable.

## Tools

| Tool | What it answers |
|---|---|
| `list_units` | What's running? What's loaded? Filter by type/state. |
| `failed_units` | Anything broken right now? |
| `unit_status` | Detailed status for one unit: active/sub state, enabled state, main PID, restart count, recent journal lines, fragment path, **drop-in override paths**. |
| `unit_show` | Full property dump (Environment vars, ExecStart, Restart policy, dependencies — 100+ properties). |
| `unit_cat` | Raw unit-file text plus drop-in overrides — equivalent to `systemctl cat <unit>`. |
| `tail_journal` | Recent log entries with optional unit / time / priority filters. |
| `list_jobs` | Currently-queued or running systemd jobs (rare; useful for stuck activations). |

All tools support `scope: "user"` to inspect `--user` units. Default scope is `system`.

## Example prompts

> _"Is anything in failed state right now?"_  → `failed_units`
>
> _"Why is `ollama.service` not using the GPU? Show me its drop-in overrides and last 50 log lines."_ → `unit_cat ollama` then `tail_journal unit=ollama lines=50`
>
> _"What did the journal say about errors and worse in the last 10 minutes?"_ → `tail_journal priority=3 since="10 minutes ago"`
>
> _"Is `nginx` enabled at boot, and how many times has it restarted since the last boot?"_ → `unit_status nginx`

## Privacy policy

This extension runs entirely on your local machine and shells out only to `systemctl` and `journalctl`. No data leaves your machine. No network I/O. Read-only — cannot modify, restart, enable, disable, or reload anything.

The information visible to Claude includes:

- **Names, descriptions, and metadata of every system or user unit you query** (or every loaded unit if you call `list_units`).
- **The full content of unit files and drop-in overrides** (`unit_cat`) — these can contain `Environment=` lines with secrets if you've set them there. Do not store credentials in unit files if you intend to enable this extension.
- **Recent journal entries** for queried units — including any messages services log, which may contain personally-identifying info, IP addresses, request paths, or stack traces.
- **Process IDs, restart counts, and runtime properties** of services.

If your unit files or journals contain sensitive data and you don't trust the LLM endpoint, do not enable this extension.

## Why no destructive operations?

A `restart_unit` / `enable_unit` / `disable_unit` set was deliberately left out of v0.1 because:

1. They require root for system-scope units, which means either running Claude Desktop as root (bad) or configuring `sudo` rules (extension-specific friction).
2. They're rarely needed in the workflow this extension actually serves — _"why is X broken"_ is the 95% case.
3. If you need to bounce a service, the existing [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp) gives you `run_command sudo systemctl restart <unit>` with the same `sudo` mechanics you'd use anywhere else, plus a confirmation step at the system prompt.

Keeping this extension read-only means it can be enabled on a production host, a shared workstation, or a customer machine without trust concerns. v0.2 may revisit this.

## Troubleshooting

**"systemctl is not installed"** — This server is Linux-only. macOS and Windows do not run systemd.

**"Permission denied" when reading journal** — Add yourself to `systemd-journal` or `adm`: `sudo usermod -aG systemd-journal $USER` then log out and back in. Or call with `scope: "user"` to read only your own user-scope journal (no group needed).

**Empty `tail_journal` results** — Some distributions have rate-limited or volatile journals. Check `Storage=` in `/etc/systemd/journald.conf` — `volatile` means the journal is wiped on reboot.

## Development

Single ~400-line Node.js script, zero npm dependencies. Rebuild the `.mcpb`:

```bash
cd bundle-source
zip -j ../Systemd.mcpb manifest.json package.json server.js README.md LICENSE icon.png glama.json
```

## License

MIT. See [LICENSE](LICENSE).

## Related

- [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp) — shell + filesystem + background jobs (use this for destructive systemctl actions).
- [claude-sessions-mcp](https://github.com/LukeLamb/claude-sessions-mcp) — tmux session management for long-running jobs.
- [claude-rocm-mcp](https://github.com/LukeLamb/claude-rocm-mcp) — AMD GPU monitoring; pairs well for "is the GPU healthy?" alongside "is the GPU service healthy?"
- [claude-linux-mcp](https://github.com/LukeLamb/claude-linux-mcp) — X11 desktop control.
- [claude-ollama-mcp](https://github.com/LukeLamb/claude-ollama-mcp) — local Ollama HTTP-API client.
