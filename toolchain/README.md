# Fork toolchain — fast harness environment

The harness builds (B1+) run against a **minimal dependency environment**
instead of the full 2700-package install: on a 2 GB sandbox, pnpm cannot
resolve the full lockfile (OOM at resolution), and `/tmp` (993 MB tmpfs)
cannot hold a repo + deps. This directory packages everything needed to
rebuild the working environment after any sandbox reset:

| File | What it is |
|---|---|
| `setup-fast.sh` | One command: node + shallow clone + deps + fastcheck kit |
| `min-deps.package.json` | The minimal dependency manifest (npm, `--ignore-scripts`) |
| `tsconfig.fastcheck.json` | typecheck:core wrapper — extends the repo config, stubs `playwright` + `@huggingface/transformers` |
| `fastcheck-stubs/` | The d.ts stubs (typed surface actually imported by the repo) |

## Layout the script builds

```
/work/node-v22.23.2-linux-x64/   node toolchain
/work/minstall/                  minimal deps (real files)
/work/omniroute/                 shallow clone of fork/parallel-execution
  └── node_modules/              symlinks → /work/minstall/node_modules
      + tsconfig.fastcheck.json + .fastcheck-stubs/ (untracked, .git/info/exclude)
```

`/work` is used because `/home/user` snapshots exclude `node_modules` and
`.git/config` (a repo there can never survive) and `/tmp` is a 993 MB
RAM-backed tmpfs. GitHub — pushed after every build — is the durable source
of truth for the repo itself.

## Deps source, in order

1. `node_modules-min.tar.xz` next to this script, if present (fastest; the
   workspace artifact copy at `omniroute-fork/toolchain/` is authoritative).
2. Otherwise `npm install` from `min-deps.package.json` (~1 min), then slim:
   remove `@img`, `@next/swc-*`, `@babel`, `svelte`, `@swc` (unneeded at
   runtime for the suites; cuts ~250 MB).

## Verified in this environment

harness-b1…b4 + provider-node-reserved-prefix + nvidia/chatCore suites:
105/105; `tsc -p tsconfig.fastcheck.json`: 0 errors. The full 461-test
services sweep and real-package typecheck remain full-deps gates (CI).
