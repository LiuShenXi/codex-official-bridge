# Native transport runtime build

This runtime links the public Codex transport, authentication and provider libraries. It is a separately built program, **not the unmodified official Codex CLI binary**. Its source checkout is fixed to:

- Repository: https://github.com/openai/codex
- Tag: `rust-v0.154.0-alpha.6.2`
- Commit: `b5bffd3ec4db487e7e3dec59663875b0ef7b72ca`
- Required Rust and Cargo: `1.95.0`

The tag is only the download selector. The build helper verifies the exact commit and rejects modified or untracked source files before using a checkout. It never changes the selected revision to a newer release.

## Check without downloading or building

Run from the project directory:

```sh
node scripts/build-native-runtime.mjs --check-only
```

This checks Git, the installed Rust toolchain, the native manifest, available disk space, and any existing official checkout. It creates no directories, downloads nothing, and does not install or switch Rust toolchains. Missing default source is reported as needing a download, not as a corrupt checkout. An explicitly supplied source path must already exist.

The build requires **at least 8 GiB of available space on the project/runtime filesystem** before source download and checks the same limit again before compilation. This is a minimum gate, not a promise that the full dependency graph fits in 8 GiB; leave additional room for Cargo dependencies and intermediate artifacts. The current transport dependencies include provider/configuration code and AWS crates.

At implementation time this Mac had approximately 3 GiB free and no `rustc`/`rustup` on PATH. The helper therefore stops before any download or compilation. No native binary has been built or validated on this machine by this step.

## Build on a prepared host

Install Git and Rust `1.95.0` yourself, or choose a host where that exact toolchain is already installed. The script never installs system packages, invokes a Rust installer, or changes the global toolchain selection.

```sh
node scripts/build-native-runtime.mjs
```

When `rustup` is present, the helper verifies that `1.95.0` is already installed and runs `rustup run 1.95.0 cargo ...`. Without rustup, both the `rustc` and `cargo` on PATH must report `1.95.0`. `RUSTUP_AUTO_INSTALL=0` is supplied to child commands.

Build locations:

| Content | Project-relative location |
|---|---|
| Verified official source | `.runtime/vendor/codex` |
| Native Rust manifest | `native-runtime/Cargo.toml` |
| Resolved native dependency lock | `native-runtime/Cargo.lock` |
| Cargo target/intermediates | `.runtime/native-target` |
| Final executable | `.runtime/bin/codex-official-runtime` |

The current Rust runtime supports **macOS and Linux only**: it imports Unix filesystem permission APIs (`std::os::unix`) and has not implemented a Windows equivalent. The JavaScript helper contains generic `.exe` filename handling, but that does not make the runtime buildable or supported on Windows. The generated binary targets the build host's OS and architecture: a Linux server build is suitable for deployment to a matching Linux host, not for running directly on this Mac.

Source download uses the public HTTPS repository into a temporary directory. Only a verified checkout is renamed into the final vendor path. Failure removes that temporary checkout; an existing vendor checkout is not overwritten. Git hooks and interactive authentication are disabled for these operations. Build/download output is not echoed because tool diagnostics can contain credential-bearing URLs; the helper prints stage names and failure codes instead.

## Reuse an existing pinned checkout

```sh
BRIDGE_CODEX_SOURCE=/absolute/path/to/codex \
  node scripts/build-native-runtime.mjs --check-only

BRIDGE_CODEX_SOURCE=/absolute/path/to/codex \
  node scripts/build-native-runtime.mjs
```

The checkout must have the exact commit above, a clean worktree, and `codex-rs/Cargo.toml`. A real build creates `.runtime/vendor/codex` as a symlink to this checkout so the manifest's fixed relative path dependencies work. The check-only command does not create that link. If the vendor path already refers to different source, the helper refuses to replace it.

The native manifest is an independent Cargo workspace. It explicitly repeats the pinned upstream `crates-io` patches and the tungstenite SSH-to-HTTPS patch because dependency-workspace patches are not inherited by consumers. Do not replace its path dependencies or patches with arbitrary crates.io versions.

For the first build, the helper seeds `native-runtime/Cargo.lock` from the verified official `codex-rs/Cargo.lock`. Cargo then adds the native root package and any additional dependencies. Once the lock contains `codex-native-runtime`, subsequent builds use `--locked`. Keep the resulting lock with the source after reviewing the first successful resolution. Changing dependencies later requires an intentional lock update; the helper does not silently unlock subsequent builds.

## Inspect a build failure locally

The helper does not print raw subprocess output. On the build host, inspect full compiler diagnostics by rerunning the corresponding command yourself:

```sh
RUSTUP_AUTO_INSTALL=0 rustup run 1.95.0 cargo build \
  --release \
  --manifest-path native-runtime/Cargo.toml \
  --target-dir .runtime/native-target \
  --bin codex-official-runtime
```

Add `--locked` when using the resolved native lock. If rustup is not installed and the exact Rust/Cargo versions are directly on PATH, use `cargo` instead of `rustup run 1.95.0 cargo`. Avoid pasting unredacted compiler/network diagnostics into a shared task if they contain private repository URLs or credentials.

A successful compilation proves the pinned source builds on that host. Authentication, live upstream requests, native tool preservation, desktop integration, and compaction still require their separate runtime acceptance checks.

## Current server build

The selected build/deployment host is `main-server`, using the project's Dockerfile and Compose configuration. The Docker build uses the Rust `1.95.0-bookworm` base pinned by manifest digest, plus the exact official Codex commit above. Its runtime image uses a separately pinned Node base and contains no official login CLI or account state.

The 2026-09-16 server build completed successfully: all three Rust tests passed, the runtime linked, and the final container started successfully. The first dependency build took approximately 15 minutes; later root-crate rebuilds reused that cache. The native Cargo.lock was extracted and retained with project source.

COPY preserves source timestamps, which can be older than a cached Cargo target. The Dockerfile touches this single-file runtime source before cargo test/build so changed source cannot accidentally reuse a stale executable. Logs confirmed both the test and serving binary were rebuilt after this fix; the new egress command was also exercised in the final container.

Live authentication, Sol native tools, model listing, V2 compaction and same-factory residential egress have passed. Desktop UI automation remains unavailable; see validation.md for exact boundaries.
