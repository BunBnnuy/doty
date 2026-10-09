# Discord image generation

Doty uses its existing text agent to prepare an image prompt. It runs image
generation with the installed Codex CLI. It uploads the PNG with the Discord
REST API. No new npm package or OpenAI API key is required.

Examples:

- DM: `Genera una imagen de un conejo astronauta.`
- Server: `@Doty genera una imagen de un bosque de noche.`
- Private delivery from a server: `@Doty genera un conejo y envíamelo por DM.`
- Reference image: attach an image and ask Doty to create or edit an image from it.

The bot's existing user and channel filters still apply. Private delivery goes
only to the user who made the request. Discord must permit the bot to attach
files in the channel. The user must permit DMs for private delivery.

The server looks for `DOTY_CODEX_BIN`, then `~/.local/bin/codex`, then `codex`
on PATH. Codex must already be signed in as the server service user and have
access to built-in image generation. `DOTY_CODEX_IMAGE_MODEL` can select the
Codex text model that controls the image tool. It does not select an image model.

Each job runs in a temporary workspace. The child does not receive Doty's
Discord token, database URL, or provider API keys. User configuration, plugins,
apps, hooks, shell tools, and subagents are disabled for the image process.
The image output must be a regular PNG in the generated-images directory for
that exact Codex session. Doty limits it to 10 MiB. Codex keeps its normal
generated image artifact; Doty removes its temporary references and metadata.
One image job can run at a time. Each job has a ten-minute timeout.

Run the server only when requested:

```text
npm -w @doty/server run start
```

Run a real image test without starting the API or sending a Discord message:

```text
node --import tsx apps/server/src/integrations/codex-images-smoke.ts
```

Run automated checks:

```text
npm -w @doty/server run typecheck
npm -w @doty/server test
```

To deploy, commit the local change and push to `origin master`. GitHub Actions
runs the checks and deploys to `kb`. Do not edit project files on `kb` directly.
