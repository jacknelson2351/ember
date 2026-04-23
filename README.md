# Ember

A macOS desktop app for security-focused AI workflows, built with React and Tauri.

## What It Does

- Runs a Pi-based coding/security agent inside a Docker-backed Kali runtime.
- Lets you chat with the runtime, attach files from Finder, or drag and drop files directly into chat.
- Provides an `Instructions` panel for base instructions, project notes, and reusable Pi-managed skills.
- Syncs instruction context into workspace-local Pi files under `.pi/`.

## Setup

You'll need:

- macOS with Xcode Command Line Tools
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone https://github.com/jacknelson2351/ember.git
cd ember/ember-pi
npm install
npx tauri dev
```

Once the app opens, go to **Settings > Model** to pick your provider and enter your API key. Ember stores provider keys in the macOS Keychain rather than local browser storage.

## Using The App

- `Chat`: Talk to Ember, attach files with the paperclip, or drag and drop files into the chat panel. Uploaded files are copied into `/workspace` before the prompt is sent.
- `Files`: Browse the shared workspace mounted into the runtime container.
- `Instructions`: Edit base instructions, manage project notes, and create or enable reusable Pi skills. Ember syncs these into `.pi/APPEND_SYSTEM.md` and `.pi/skills/ember-managed/`.
- `Settings`: Configure the model provider and manage the Docker runtime.

## Project Structure

```
ember-pi/    React + Tauri desktop app
docker/      Docker build context for the container runtime
config/      Default runtime config examples
```

## Development

```bash
cd ember-pi
npx tauri dev
```

> If port 1420 is busy, kill the stale Vite process and retry.

## Production Build

```bash
cd ember-pi
npm run tauri build
```

## Troubleshooting

- **App won't start?** Make sure Rust and Xcode CLI tools are installed.
- **Runtime won't start?** Check that Docker Desktop is running.
- **Model calls failing?** Double-check your provider, endpoint, and API key in Settings.
