# Private browser worker

Chromium + Xvfb + Openbox run in one small Linux container. The Node worker uses
the Chrome DevTools Protocol for page navigation and accessibility. It uses
ffmpeg and xdotool for desktop screenshots and input. It has no general shell
tool. All input commands use fixed executable names and argument arrays.

## Use

Open https://doty.killbunny.top/browser and enter the existing Doty API token.
Use **Run task**, or send `!browser <task>` in the owner's Discord DM. The owner
is DOTY_DISCORD_USER_ID, else a single shared-session user, else a single allowed
user. Server channels cannot access the browser.

Doty uses a separate OpenCode planning session with all tool permissions denied.
It sees a desktop screenshot and page accessibility text. It can navigate and
read automatically. Every click, key press, and typing action needs approval in
the browser page. Review the visible page and pending action before approval.
**Take control / Stop AI** cancels the task and enables manual input. An action
already sent to the worker can finish. Start a new task to return control to Doty.
Enter passwords only in human mode. Task results stay on this private page;
they are not published in the shared Doty event stream or Discord servers.

The UI holds the API token in memory only. Browser cookies persist in the named
Docker volume `doty-browser-profile`. The volume also contains browser cache and
history; treat it as private data. Screenshots and accessibility text are sent to
the configured model provider during AI tasks and stored in OpenCode history.
The first version has one workspace, one job, 20 actions and a 10-minute job limit.
It has no file transfer or general desktop application tools.

## Deployment

The normal master deployment calls `bash apps/server/scripts/provision-browser.sh`
when the worker or provisioning script changes. The script installs Docker from
the official Ubuntu repository, builds the image and creates two networks.
The worker is on an internal network. Only its egress proxy has an external
network. The proxy permits HTTP/HTTPS on ports 80/443 and blocks private,
reserved, loopback, metadata, IPv6 and server-local IP addresses. It pins each
connection to the checked DNS result. The worker API binds on host loopback only.
An INPUT firewall rule blocks new connections from the internal bridge to host
services. A systemd unit restores that rule before Docker starts after reboot.
The public API requires DOTY_TOKEN, including when other development routes are
open. A separate generated root-owned worker token is injected with systemd.
No host directory, host credential file or Docker socket is mounted.

Limits: worker 2 CPUs, 1536 MiB RAM, 256 processes; proxy 0.25 CPU, 128 MiB RAM,
64 processes. Both run as non-root with read-only root filesystems, all Linux
capabilities removed and no new privileges. Chromium's sandbox stays enabled.
`seccomp.json` is derived from Moby profiles commit
`6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef`, with clone, clone3, unshare and setns
and chroot allowed for Chromium's namespace sandbox. Docker's default AppArmor profile is
retained. This shares the host kernel; it is not VM-level isolation.

Environment: BROWSER_WORKER_TOKEN (provisioned), BROWSER_WORKER_URL (default
http://127.0.0.1:8890), BROWSER_MODEL (default OPENCODE_MODEL, else
opencode-go/deepseek-v4.1-flash). Use a non-OpenAI vision model through OpenCode.
OpenAI models must use Codex CLI under the project rule; this planner currently
does not provide a Codex backend.

Verification: `npm run typecheck -w @doty/server`,
`npm run test -w @doty/server`,
`node --test apps/server/browser-worker/egress-check.mjs`.
The deploy smoke test checks worker auth, real HTTPS navigation, accessibility,
desktop PNG size, and scroll input. It also runs one bounded read-only AI task
through OpenCode to verify vision input, planning, navigation and the answer.

Rollback: revert the server commit and deploy it. Host Docker packages, volume,
networks and systemd drop-in remain; remove them only through a reviewed cleanup
script if needed. Existing browser sessions remain private in the volume.
