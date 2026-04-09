# Ember

A macOS desktop app for security-focused AI workflows, built with React and Tauri.

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

Once the app opens, go to **Settings > Model** to pick your provider and enter your API key.

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
