# Contributing

Thanks for looking. orbital is deliberately small — about 3,900 lines of its own code across 16
files, no build step, no `npm`, Python standard library only. That is a feature: you should be able
to read the whole thing in a sitting and trust what you run. Contributions are welcome as long as
they keep it that way.

---

## Principles (please keep these)

- **Small and auditable.** Prefer the simplest change that works. No new runtime dependency, no
  build pipeline, no framework. If a change needs `npm` or `pip install`, it probably belongs in a
  fork, not here.
- **Privacy is structural, not a promise.** The default must keep reading nothing real, the server
  must stay read-only and GET-only, and nothing may bind to a non-loopback address by default. See
  [`THREAT_MODEL.md`](THREAT_MODEL.md) — a PR that weakens any line in "What it protects against"
  will be asked to change.
- **Match the surrounding code.** Same comment density, same naming, same idioms. The code explains
  *why* in comments; keep that up.

---

## Set up and run

```sh
git clone https://github.com/NEO849/orbital
cd orbital
./run.sh                      # synthetic demo -> http://127.0.0.1:8080
```

Requires only `python3` (3.9+). three.js is vendored under `web/vendor/`, so there is no install
step. `AOS_PORT=9000 ./run.sh` runs on another port.

Before you change anything, read it in this order: [`README.md`](README.md) (what and why) →
[`SCHEMA.md`](SCHEMA.md) (the producer↔web data contract) → `collector/demo.py` (how the demo is
driven) → `web/src/` (the renderer).

---

## The shape of the project

Three parts joined only by two files on disk — so you can almost always work in just one:

| You want to… | Work in |
|---|---|
| change what data is shown / add a data source | `collector/` (`demo.py` synthetic, `collector.py` live) |
| change how it looks or moves | `web/src/` (`scene`, `layout`, `nodes`, `flows`, `zones`, `hud`) |
| change how files are served | `collector/serve.py` (keep it GET-only + path-guarded) |

**The highest-value contribution** is a new **producer**: `collector.py` targets Claude Code's
`~/.claude` layout, but anything that can write the [`SCHEMA.md`](SCHEMA.md) shape to `state.json`
+ `events.jsonl` works unchanged downstream. A collector for another agent runtime is a clean,
self-contained addition that touches nothing else.

---

## Before you open a PR

Run these from the repo root:

```sh
python3 tools/scan_private.py     # privacy gate — must exit 0 (no private marker in any tracked file)
./run.sh                          # demo must still render in a browser (drag to orbit, flows stream)
```

Checklist:

- [ ] `tools/scan_private.py` exits 0 — **never commit a real path, host, IP, or personal name.**
      If you added an example, use placeholders (`/home/<user>/…`, `127.0.0.1`).
- [ ] No new dependency; still Python stdlib + vendored three.js only.
- [ ] The demo still runs and renders; if you touched the web app, check it in a real browser.
- [ ] Comments explain the *why* of anything non-obvious, in the style of the file you edited.
- [ ] The change is scoped — no drive-by reformatting of code you did not otherwise touch.

If you add or change the data contract, update [`SCHEMA.md`](SCHEMA.md) in the same PR.

---

## Submitting

Open a PR against `main` with a short description of *what* changed and *why*. Keep commits focused;
a small, reviewable PR lands faster than a large one. For anything security-relevant, see the
reporting note in [`THREAT_MODEL.md`](THREAT_MODEL.md).

By contributing, you agree your contribution is licensed under the project's
[MIT License](LICENSE).
