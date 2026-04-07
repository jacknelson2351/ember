# Ember

Ember is a macOS-first Tauri desktop app for security-focused AI workflows. It uses a floating toolbar UI and expands into panels for chat, terminal access, files, memory, thoughts, and runtime controls.

## Repo Layout

- `ember-pi/`: React + Tauri desktop application
- `docker/`: Docker build context for the container-backed runtime
- `config/`: default runtime configuration examples

## Prerequisites

Before running Ember locally, install:

- macOS with Xcode Command Line Tools
- Node.js 20 or newer
- Rust toolchain (`rustup`)
- Docker Desktop
- A model provider:
  - LM Studio at `http://localhost:1234/v1`, or
  - OpenAI, Anthropic, or another OpenAI-compatible endpoint

## Local Setup

```bash
git clone https://github.com/jacknelson2351/ember.git
cd ember/ember-pi
npm install
npm run tauri dev
```

After the app launches:

1. Open `Settings -> Model`.
2. Choose your provider.
3. Enter the endpoint, model name, and API key if the provider requires one.
4. Start the runtime from the runtime status control or `Settings -> Container`.

## Runtime Behavior

- Docker is required for the container-backed workspace features.
- The Docker image is built from the repo-root `docker/` directory.
- On first run, the app creates writable `shared`, `config`, and `memory` directories under its application data directory.
- Packaged builds bundle the repo-root `docker/` directory so the runtime can still be prepared outside development mode.

LM Studio is the default local-model path:

- Endpoint: `http://localhost:1234/v1`
- Model: set inside `Settings -> Model`

## Development

From `ember-pi/`:

```bash
npm run tauri dev
```

If port `1420` is already in use, stop the stale Vite dev server and rerun the command.

## Production Build

From `ember-pi/`:

```bash
npm run tauri build
```

The packaged desktop app includes the runtime Docker context from the repo root.

## Troubleshooting

- If the runtime will not start, verify Docker Desktop is installed and running.
- If model calls fail, re-check the provider, endpoint, model name, and API key in `Settings -> Model`.
- If the UI opens but the backend fails to compile, confirm the Rust toolchain and Xcode Command Line Tools are installed.
