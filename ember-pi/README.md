# Coalfire Ember

Coalfire Ember is a macOS-first Tauri desktop toolbar for security-oriented AI workflows. The current shell is a centered floating pill that expands into a single panel workspace for chat, files, instructions, and settings.

## Current UI Model

- The app opens as a centered floating pill near the top of the screen.
- Click the Coalfire logo or `Ask` to open chat.
- Click `Files`, `Instructions`, or `Settings` to open those panels.
- Use the left drag handle to move the pill.
- Use the chevron to collapse the active panel.
- Use `×` to quit the app.

## Chat

- Chat runs against the Pi-based runtime inside the Docker container.
- Use the paperclip button to attach files, or drag and drop files directly into the chat panel.
- Attached files are copied into `/workspace` before the message is sent, and Ember is prompted to read them from there.

## Instructions

- `Base Instructions` are always applied and synced into `/workspace/.pi/APPEND_SYSTEM.md`.
- `Notes` are short project reminders that can be included or excluded from Pi context.
- `Skills` are reusable Pi-managed workflows synced into `/workspace/.pi/skills/ember-managed/`.
- `Generated Pi Files` is an advanced preview of the files Ember writes for Pi automatically.

## Model Providers

- LM Studio
- Ollama
- OpenAI
- Anthropic
- Custom OpenAI-compatible endpoint

LM Studio remains the default local-model path:
- Endpoint: `http://localhost:1234/v1`
- Model: set in `Settings -> Model`

## Fresh Machine Setup

1. Install Docker Desktop and launch it.
2. Launch LM Studio if you want a local model, or prepare your remote provider credentials.
3. Launch Coalfire Ember.
4. Open `Settings -> Model`.
5. Choose your provider and save the endpoint, model name, and API key if needed.
   API keys are stored in the macOS Keychain instead of browser persistence.
6. Start the runtime from the runtime status control or `Settings -> Container`.

The app creates and reuses writable runtime data under its application data directory. Docker image and container bootstrap are handled by the app runtime commands.

## Runtime Notes

- Docker is required for the container-backed runtime features.
- LM Studio does not require an API key by default.
- The app bundles the repo-root `docker/` build context for packaged builds.
- Current shell behavior was updated on April 7, 2026 to use explicit toolbar press handlers and a dedicated drag handle instead of full-header native drag regions.

## Development

```bash
cd ember-pi
npm install
npm run tauri dev
```

If a stale dev server is still bound to port `1420`, stop it before relaunching.

## Production Build

```bash
cd ember-pi
npm run tauri build
```

The desktop bundle includes the Docker build context from the repo root `docker/` directory, so packaged builds can still prepare the runtime container.
