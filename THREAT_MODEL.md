# Threat model

orbital is a **local viewer**, not a sandbox. This document states plainly what its design
protects against and — just as important — what it deliberately does **not**. If a guarantee is not
listed under "What it protects against," do not assume it.

> **One-line version:** orbital reads your data locally and shows it in your browser. The two things
> it is built to get right are (1) not leaking your data when you publish the *engine*, and (2) not
> exposing your data over the network by default. It makes no isolation or sandboxing claims.

---

## Assets and trust boundary

| Asset | Where it lives |
|---|---|
| Your agent workspace (`~/.claude`: session transcripts, memory, services) | your local disk — read in **live** mode only |
| The rendered snapshot (`state.json`, `events.jsonl`) | your local disk, written by the producer |
| The engine source | this public repo |

Trust boundary: **everything the producer reads and writes stays on your machine.** The producer
reads locally and only ever *writes* to local disk; the server only *reads* that disk; nothing in the
pipeline makes an outbound connection. The browser talks only to your local server.

```
  your browser  --GET-->  serve.py (127.0.0.1)  --reads-->  state.json / events.jsonl
                                                                 ^
                      demo.py (reads nothing)  / collector.py (reads ~/.claude, read-only)
  └──────────────────────── all of this is local; nothing is pushed or phoned home ───────────┘
```

---

## What it protects against

| Threat | Mitigation (in code) |
|---|---|
| **Leaking your data when you publish the engine** | default `mode=demo` reads nothing; operator config (`aos.local.json`), runtime state and logs are gitignored; `tools/scan_private.py` scans every publishable file for private markers before a push |
| **Exposing your data over the network unintentionally** | `serve.py` binds `127.0.0.1` by default — **never `0.0.0.0`**; your real bind lives only in a gitignored override |
| **The server being used to reach other files** | `serve.py` is **GET-only** (POST/PUT/DELETE/… → 405); a strict path guard rejects `..`, backslashes and null bytes and serves static files only from inside `web/`; `X-Content-Type-Options: nosniff` on responses |
| **The viewer modifying or running your workspace** | `collector.py` opens your files **read-only** — it never writes to, patches, or executes anything in `~/.claude`; the pipeline is purely a read-and-render |
| **A malicious string in your own data running as code** | the web app renders every value via `textContent` / `createTextNode` — **never `innerHTML`** — so data is displayed as inert text, not executed (no DOM-XSS from workspace content) |

---

## What it does NOT defend against (stated honestly)

- **No authentication.** The server has no login. If you bind it to anything other than loopback,
  **anyone who can reach that address can read your `state.json`.** For non-loopback use, put it
  behind a reverse proxy or a private network (e.g. a VPN) — do not bind it to the open internet.
- **Live mode trusts your local workspace.** `collector.py` renders whatever is in `~/.claude`.
  It is designed for *your own* data; it is not a tool for safely inspecting an untrusted workspace.
- **Not a sandbox.** orbital makes no isolation claims. It does not contain, limit, or analyze
  hostile input — it visualizes data you already trust. (If you need isolation for untrusted
  binaries, that is a different kind of tool.)
- **The leak scanner is a net, not a proof.** `tools/scan_private.py` catches known patterns
  (home paths, private IP ranges, operator markers) run case-insensitively. It reduces the chance of
  an accidental leak; it does not guarantee its absence. **Human review before any publish stays
  mandatory**, and `git commit --amend` leaves the pre-fix content in dangling objects — prune with
  `git reflog expire --expire=now --all && git gc --prune=now` before publishing a `.git` by any
  means other than a plain `git push`.
- **Your machine, browser and OS are out of scope.** orbital assumes the host it runs on and the
  browser you view it in are themselves trustworthy.

---

## Reporting a security issue

If you find a way orbital leaks data it shouldn't, or exposes the local workspace beyond what this
document describes, please open a GitHub **security advisory** (Security → Report a vulnerability) on
the repository rather than a public issue, so it can be fixed before it is widely known.
