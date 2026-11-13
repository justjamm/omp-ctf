# omp-ctf

Oh My Pi plugin that adds `/ctf`: containerized, operator-supervised automation for **authorized** CTF competitions — challenge discovery, browsing, downloads, analysis, solving and (confirmed) flag submission.

Design notes: [CTF-Plugin-Plan wiki page](https://github.com/justjamm/omp-ctf/wiki/CTF-Plugin-Plan). VM testing guide: [VM-Test-Handoff](https://github.com/justjamm/omp-ctf/wiki/VM-Test-Handoff).

**Status:** unit tests and typecheck pass, and the isolated head/worker sessions were checked against the real OMP 18.20.0 SDK. On macOS (Colima) the setup script, both image builds, the browser container (loopback-only noVNC with token enforcement, no CDP), driver navigate/observe/screenshot/download, the download broker, and challenge-container hardening have been verified. A full model-driven `/ctf` run against a real CTF site has **not** been exercised yet.

**Supported hosts:** macOS and Linux (apt- or dnf-based). Windows is not supported.

## Install

From a checkout, run the one-time setup script in a normal terminal (not inside the OMP TUI; it may ask for your `sudo` password):

```sh
git clone https://github.com/justjamm/omp-ctf && cd omp-ctf
./scripts/setup.sh        # or: bun run setup (once Bun exists)
```

It installs anything missing and is safe to re-run:

| Step | macOS | Linux (apt or dnf) |
| --- | --- | --- |
| Base tools | Homebrew (if missing) | `curl`, `ca-certificates`, `gnupg`, `unzip`, `git`, `xdg-utils` |
| Docker | Colima + `docker` CLI + buildx via Homebrew; starts Colima (4 CPU, 8 GiB, 60 GiB disk) | Docker Engine from Docker's official repository (`docker-ce`, `containerd.io`, buildx); enables the daemon; adds you to the `docker` group. Derivatives without their own Docker suite (e.g. Kali `kali-rolling`) use the newest supported Debian/Ubuntu suite (`trixie`/`bookworm`, `noble`/`jammy`). A broken `docker.list` from an earlier run is removed and re-created. |
| Bun | official installer (`~/.bun`) | official installer (`~/.bun`) |
| Oh My Pi ≥ 18.20.0 | `brew install can1357/tap/omp` | `bun install -g @oh-my-pi/pi-coding-agent` |
| Repo | `bun install --frozen-lockfile`, builds `omp-ctf-browser:pw1.65.0-1` and `omp-ctf-challenge:1`, `omp plugin link .` | same |

On Linux, if you were just added to the `docker` group, log out and back in (or `newgrp docker`) before starting `omp`.

The package is not published to npm yet; install from a checkout as above. To re-link manually after pulling changes:

```sh
omp plugin link .
```

## Runtime Docker checks

`/ctf` itself never installs software. Before it creates anything it checks that the `docker` CLI is on `PATH` and that `docker info` succeeds. If the CLI is missing, it points you at the setup script. If the daemon is down, it says how to start it (`colima start` or `sudo systemctl start docker`, or to log in again if your user can't reach the Docker socket yet) and creates no resources. Missing images are built on first use.

## Commands

| Command | Effect |
| --- | --- |
| `/ctf [event]` (or `/ctf start [event]`) | Pick the head model (every time) and worker models (first time), check Docker, then open the contained Chromium browser. Navigate to the challenge website there and sign in yourself, return to the TUI, and answer **"Have you signed into the challenge website?"** — **Yes** starts the run on the page you signed into, **No** cancels. Passing an existing event id reuses that event's browser profile. |
| `/ctf help` | Usage. |
| `/ctf status` | Event/challenge states, models, running workers, sign-in state, network warning. |
| `/ctf stop` | Idempotent. Aborts workers and pending dialogs, removes the event's containers. Volumes and browser profile are kept. |
| `/ctf settings` | View/change worker models, max concurrent workers (1–8, default 4) and auto-submit. |
| `/ctf settings auto-submit on\|off` | Default **off**: every flag submission needs your confirmation. |
| `/ctf history` | Lists prior events/challenges to you only. With an active run you may select one exact artifact and approve copying it into a current challenge. |
| `/ctf purge <event-id>` | After confirmation, deletes only that event's containers, volumes and metadata. |
| `/ctf reset-config` | Replaces `~/.omp/ctf/config.json` with defaults (the only way to replace a malformed config). |

Only one run is active per OMP process; starting another tells you to stop the first. Exiting OMP stops containers without deleting data.

The plugin never navigates for you before you answer. When you answer **Yes**, it reads the page the browser is showing (if you signed in on a new tab, that tab is used) and gives that URL to the head. If the browser isn't on an http(s) page, it asks again.

## Models: head vs. workers

- **Head**: chosen in the picker at every `/ctf`, never saved. You choose your abliterated coordinator model here; the plugin cannot verify model properties. The head can browse, dispatch, ask you, and submit flags; it **cannot** execute code.
- **Workers**: one or more standard models saved in config. Each dispatched challenge gets one worker (round-robin), its own container and volume, and the tools `ctf_browser`, `ctf_exec`, `ctf_submit_flag`, `ctf_ask_user`.
- The head model may not also be a worker. Unavailable/unauthenticated models fail setup; there is no silent fallback, and cross-model retry fallback is disabled.
- A worker refusal is reported as `refused` and is final for the run: it is never retried with the head model, and the head cannot re-dispatch it.

Every CTF session is an isolated in-memory SDK session: no transcripts persisted, no memory, skills, rules, context files, MCP, LSP, extensions or project context, and a restricted allowlist of only the `ctf_*` tools. Your ordinary OMP session keeps its normal model and tools.

## Containers and security boundaries

- **Browser container**: headed Playwright Chromium (pinned 1.65.0) on Xvfb, VNC inside the container only, and noVNC published on a random `127.0.0.1` port protected by a random per-run token. No CDP port is exposed. Models can invoke only a fixed set of operations (`navigate`, `observe`, `click`, `fill`, `press`, `back`, `forward`, `screenshot`, `download`, `listChallenges`, and submission via `ctf_submit_flag`); there is no arbitrary JavaScript. Only `http:`/`https:` URLs are accepted.
- **Challenge containers**: one per challenge, mounting only its own named volume at `/work`. No host paths, host environment, Docker socket, browser profile or other challenge volumes are mounted. The host broker copies each requested download (≤100 MiB) from the browser into exactly that challenge's `/work/downloads`.
- All containers: `--init`, non-root UID 10001, `--cap-drop=ALL`, `no-new-privileges`, CPU/memory/PID limits, no privileged mode, devices, host network or host PID. As a result `apt` is unavailable at runtime; workers install tools inside the container with `pip install --user`, `python3 -m venv /work/.venv`, or `npm --prefix /work`.
- `ctf_exec` takes argv (or an explicit shell script that runs only inside the container), workspace-relative `cwd`, and rejects `..` traversal and host paths before any Docker call. Output is capped at 1 MiB.

> **Network warning:** containers use normal outbound Docker networking. This does **not** isolate your host LAN or cloud metadata endpoints, and it does not prevent outbound exfiltration. Targets reachable only through a host VPN/private LAN may be unreachable from the containers.

## Data

- `~/.omp/ctf/config.json` (owner-only): `{ "version": 1, "workerModels": [], "autoSubmit": false, "maxWorkers": 4 }`.
- `~/.omp/ctf/events/<event-id>.json`: minimal event/challenge manifests for status, history and purge.
- Docker volumes labelled `omp-ctf.event=<event-id>`: browser profile and per-challenge workspaces.

Earlier events' materials are never given to a model unless you select and approve a specific artifact in `/ctf history`.

## Development

```sh
bun install
npm test           # bun test
npm run typecheck  # tsc --noEmit
```
