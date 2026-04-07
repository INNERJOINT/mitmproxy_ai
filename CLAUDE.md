# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mitmproxy is an interactive, SSL/TLS-capable intercepting proxy for HTTP/1, HTTP/2, HTTP/3, and WebSockets. It ships three tools:
- **mitmproxy** — TUI (urwid-based console interface)
- **mitmdump** — CLI tool (tcpdump-style, no UI)
- **mitmweb** — Web UI (Flask backend + React frontend in `web/`)

## Development Setup

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```shell
uv run mitmproxy --version   # creates .venv and installs everything
source .venv/bin/activate     # optional: activate venv directly
```

## Common Commands

```shell
# Full test suite (lint + mypy + pytest)
uv run tox

# Run only pytest
uv run tox -e py

# Run a single test file with coverage
uv run pytest --cov mitmproxy.addons.anticache --cov-report term-missing test/mitmproxy/addons/test_anticache.py

# Lint
uv run tox -e lint

# Type checking
uv run tox -e mypy

# Auto-fix lint issues
uv run tox -e fix
```

## Architecture

### Core Pipeline

`Master` (`mitmproxy/master.py`) is the central event loop orchestrator. It owns:
- `AddonManager` — manages addon lifecycle and event dispatch
- `Options` — configuration via `mitmproxy/optmanager.py`
- `CommandManager` — user-facing commands

### Proxy Engine (`mitmproxy/proxy/`)

The proxy uses a layered architecture with command/event separation:
- **Layers** process protocol-specific logic (TLS, HTTP/1, HTTP/2, HTTP/3, QUIC, DNS, TCP, UDP, WebSocket)
- Layers emit **commands** (open connection, send data, hook into addons) and receive **events** (data received, connection closed)
- `proxy/server.py` runs the asyncio server: one coroutine per client connection, processes layer commands, dispatches IO events
- `proxy/context.py` provides `Context` (client/server connections, options, layer stack) passed to each layer

### Addon System (`mitmproxy/addons/`)

Addons are the primary extension mechanism. They receive lifecycle hooks (request, response, error, etc.) dispatched by the `AddonManager`. `addons/__init__.py:default_addons()` lists all built-in addons. User scripts loaded via `script.ScriptLoader` follow the same hook API.

### Key Modules

- `mitmproxy/net/` — low-level network: HTTP parsing, DNS, TLS utilities
- `mitmproxy/contentviews/` — content rendering (JSON, HTML, protobuf, gRPC, images, etc.)
- `mitmproxy/io/` — flow serialization/deserialization (read/write capture files)
- `mitmproxy/flow.py` — core flow data model
- `mitmproxy/connection.py` — Client/Server connection abstractions
- `mitmproxy/tools/console/` — TUI implementation (urwid)
- `mitmproxy/tools/web/` — Web UI backend (Flask); frontend lives in `web/` (React/Node)

### Rust Components

`mitmproxy_rs` is a companion Rust crate providing performance-critical functionality. It's an external dependency, not built from this repo.

## Code Conventions

- **Imports**: ruff enforces single-line imports, sorted with `isort` rules. `mitmproxy`, `mitmproxy_rs`, and `test` are "first-party".
- **Async tasks**: Never use `asyncio.create_task()` directly — use `mitmproxy.utils.asyncio_utils.create_task` instead (prevents GC footgun). This is enforced by ruff TID251.
- **Tests**: Mirror source structure under `test/`. Async tests use `pytest-asyncio` with `asyncio_mode = "auto"`. Default timeout is 60s.
- **Test helpers**: `mitmproxy/test/taddons.py` (addon test context), `mitmproxy/test/tflow.py` (test flow factories), `mitmproxy/test/tutils.py` (test utilities).
- **Coverage**: The project targets 100% coverage for many modules. `individual_coverage` tox env enforces per-file coverage for non-excluded files.
- **Type checking**: mypy with `check_untyped_defs = true`. Test files are excluded from mypy.
- **Linting rules**: ruff selects E, F, I, TID251; ignores F541 (f-string without placeholders) and E501 (line length).
