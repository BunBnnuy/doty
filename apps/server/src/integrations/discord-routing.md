# Discord routing

Explicit browser/music commands and reminders keep their existing priority.
For other messages one JEV choice selects a voice/music command, direct AI reply,
web lookup, or image creation/editing. Direct AI is the default for conversation,
stable questions, coding and image analysis. Web lookup is for explicit searches,
current external facts, website checks and finding existing images. Image creation
or editing uses the existing Codex CLI workflow, with attachments and DM delivery.

Only the owner DM can start browser tasks. The main response model does not make
another routing choice. Earlier routing instructions in its conversation are
overridden for the current message. If JEV fails or is absent, normal messages use
direct AI and the existing voice-command fallback remains available.

Check with `npm run test -w @doty/server`. The deployment runs the read-only
`node --import tsx apps/server/src/integrations/discord-routing-smoke.ts` check
when routing code changes. This calls JEV using the runtime configuration and
does not send Discord messages, open a browser or generate an image.
