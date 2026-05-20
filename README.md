# Feynman for Obsidian

A research agent for your vault. Runs locally in Docker against your own Anthropic API key.

![Screenshot placeholder — chat view](docs/screenshot-chat.png)

## Requirements

- Obsidian >= 1.5.0
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running (macOS, Linux, or Windows)
- An [Anthropic API key](https://console.anthropic.com/) (`sk-ant-...`)

## Install

### Option A — build from source

```sh
git clone https://github.com/alexandermrogers/feynman-research-agent.git
cd feynman-research-agent
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault at:

```
<vault>/.obsidian/plugins/feynman/
```

Reload Obsidian, open **Settings → Community plugins**, and enable **Feynman**.

### Option B — BRAT (no local build)

If you'd rather not build locally, install via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add this repository as a beta plugin and BRAT will fetch the release artifacts for you.

## Quick start

After enabling the plugin, follow [`docs/SETUP.md`](docs/SETUP.md) to pull the Docker image, configure your Anthropic key, and run your first workflow.

## Privacy & Security

Read this carefully before using the plugin.

- **API keys are stored in plaintext.** Your Anthropic API key (and any optional provider keys you add — OpenAI, Exa, Perplexity, Gemini) are written verbatim to `<vault>/.obsidian/plugins/feynman/data.json`. The plugin does not encrypt this file. If you have **Obsidian Sync** with "Sync plugin config" enabled, this file will sync to every device on that account.
- **The server runs on loopback by default.** The plugin talks to a Docker container bound to `127.0.0.1`. There is no cloud/managed-Modal tier shipped in v1 — that mode is disabled in settings until a later release.
- **A random bearer token guards the loopback server.** On first **Set up Docker** the plugin mints a 32-byte hex `FEYNMAN_AUTH_TOKEN` and writes it into the container env-file. Without that header any other process on your machine (browser tabs included) gets `401 Unauthorized` from `http://127.0.0.1:7777`. Self-hosted users must set the same env var on their server and paste the value into Settings.
- **Self-hosted base URLs are HTTPS-only outside loopback.** The settings UI rejects `http://` for any host that isn't `127.0.0.1`, `localhost`, or `::1`, so the bearer token doesn't fly in plaintext.
- **Outbound LLM traffic goes from your local Docker container directly to Anthropic.** The plugin itself does not forward prompt content, vault content, or tool I/O to any third party.
- **The optional waitlist signup POSTs your email to `api.getwaitlist.com`** (a third-party service) if and only if you submit the waitlist form. The waitlist UI is gated off by default in v1.
- **Tool calls require explicit approval.** Any tool the agent wants to run (filesystem write, shell, etc.) surfaces a modal with the actual command and path. **Deny** is the default-focused button.

If you don't want your keys leaving the device on which you typed them, disable **Sync plugin config** in Obsidian Sync settings, or use a vault that isn't syncing.

## Notes on Obsidian APIs

The plugin uses one non-public API to deep-link into its own settings tab from inline "Open settings" affordances (the `app.setting.open()` / `app.setting.openTabById(...)` pair). The calls are wrapped in `try/catch`; if a future Obsidian release removes that surface the plugin falls back to a Notice that says "Open Settings → Community plugins → Feynman". No functionality is lost; the deep link just becomes a manual click.

## License

[MIT](LICENSE).
