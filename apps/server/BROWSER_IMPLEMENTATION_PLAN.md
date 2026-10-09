# Doty browser and desktop implementation plan

Date: 2026-10-09. Status: deployed after the user approved a
light browser and graphical environment and rejected a separate VM.
The current implementation and setup are documented in browser-worker/README.md.
The sections below preserve the initial resource review and staged plan.

Verified on kb: Chromium's sandbox is enabled; real HTTPS navigation,
accessibility text, a 1280x720 desktop screenshot, and input work. A restricted
DeepSeek vision planner opened example.org and reported the real heading and
source URL. Direct internet, host API, loopback and metadata access from the
worker are blocked. API health is 200, and the private browser API rejects
requests without the owner token. Local type checks and 195 tests passed.
The basic-page sample used about 276 MiB for the worker and 42 MiB for the proxy.
This is not a complex-site or peak-load measurement. Private account login and
the owner's end-to-end Discord command were not tested.

## Decision

Basic browser automation is viable on kb with one active browser job and strict
resource limits. Start with an isolated Chromium worker. Add a visible browser
and user takeover next. Add a lightweight desktop only when a task needs it.

A desktop is useful for login, verification, file dialogs, document applications,
and tasks that need a GUI. It does not give an agent computer-control tools by
itself. Full GUI control needs screen observation and mouse/keyboard tools.

A full nested VM on kb is technically plausible, but not recommended at present.
Memory headroom is small. A separate worker VM is the better future option for
heavy GUI work or a stronger boundary between the agent and production services.

## Verified server snapshot

Read-only SSH inspection, around 12:48 Mexico City time on 2026-10-09:

| Item | Observation |
| --- | --- |
| Host OS | Ubuntu 26.04 LTS, x86_64 |
| CPU | 6 visible vCPUs, Intel Haswell virtual CPU |
| RAM | 11,671 MiB total; about 3,038 MiB available in the second sample |
| Swap | None |
| Disk | 96 GiB filesystem; about 72 GiB available |
| Load | 2.26 / 1.92 / 1.74 at the first sample |
| CPU sample | About 86 percent idle over four one-second intervals |
| Doty service RAM | About 286 MiB, from systemd MemoryCurrent |
| Minecraft service RAM | About 5.45 GiB; MemoryPeak about 5.54 GiB |
| OpenCode | 1.18.35; opencode-serve.service is active |
| Deployment | e6bc765 is present on kb |
| Container/browser/desktop tools | Docker, Podman, Chromium, Chrome, Xvfb, x11vnc, virt-install, and qemu-system-x86_64 were not on the inspection PATH |
| Virtualization | Host is a KVM guest; vmx flag and /dev/kvm are present; kvm_intel nested parameter is Y |
| KVM access | ubuntu is not in the kvm group; read/write checks for /dev/kvm did not succeed |

This is a short snapshot, not a peak-load benchmark. It does not prove nested
VM startup, browser compatibility, or performance during a Minecraft peak.
No credentials, secrets, project files on kb, or existing services were changed.

## Proposed resource budget

These are trial budgets, not vendor requirements or measured browser usage:

- One active job and at most three tabs.
- Browser worker: at most 2 vCPUs and 1.5 GiB RAM, including shared-memory use.
- Browser files: a 5 GiB initial budget with download size and retention limits.
- Stop the worker after ten idle minutes. Keep only its permitted persistent state.
- Reserve at least 1 GiB of host available memory during the trial. Refuse new
  jobs under pressure. Recheck immediately before launch, and enforce container
  memory limits independently of this check.
- Include any separate OpenCode browser process in the combined resource test.
  A dedicated instance may add roughly the current OpenCode footprint, but must
  be measured. Do not assume the worker budget covers this extra process.
- Do not change Minecraft limits or add swap as part of this feature.
- If the browser cannot meet the budget, use a separate worker host or add RAM.

## Architecture

```text
Private owner request -> Doty -> browser-enabled OpenCode execution
                                  -> restricted MCP gateway
                                  -> isolated Chromium worker

Owner browser -> authenticated viewer -> the same Chromium session
```

Use a Playwright-based service with a small MCP tool surface. OpenCode 1.18
supports MCP. Keep the browser worker transport independent of its host so it
can later move to a separate VM without changing the user's request flow.

Do not expose a general browser MCP endpoint to every existing OpenCode session.
Doty accepts Discord messages from multiple users and uses shared guild sessions.
For the first release, browsing is for the owner in private conversations only.
The owner identity comes from the authenticated request, not a model-supplied
user id. Use a dedicated browser-enabled execution instance or equivalent
server-enforced separation. Public guild agents must not reach private profiles.

Chromium runs as a non-root user with its browser sandbox enabled. Use a separate
container user, a suitable seccomp profile, private storage, and bounded shared
memory. Do not mount the Docker socket, host home, Doty environment, or agent
credential directories. Container installation and runtime access are separate
infrastructure tasks; do not give the agent host administration rights.

The gateway restricts its API, files, and network destinations. Block access to
the host, internal services, metadata endpoints, and private networks, including
redirects and DNS changes. MCP origin flags alone are not a security boundary.
Website text is untrusted task data. It cannot grant permissions or start tools.

## Phase 1: public website browsing

Implement a server module and restricted MCP gateway inside apps/server.
Proposed files: src/browser/service.ts, src/browser/policy.ts,
src/routes/browser.ts, src/mcp/browser-mcp.ts, and browser worker build files.
Exact names can change during implementation. Shared contracts remain frozen.

Expose navigation to permitted public HTTPS pages, structured page reading,
screenshots, and bounded downloads. Do not expose arbitrary page JavaScript,
shell execution, local file URLs, unrestricted filesystem access, or logged-in
profiles. Link traversal must pass the same navigation checks. This phase does
not enable general form submission or arbitrary clicking with account effects.

Doty reports progress and returns links, summaries, screenshots, or downloads.
Add queueing, cancellation, deadlines, cleanup, and worker health reporting.
Add an optional feature flag so browser failures cannot disable ordinary chat.

Acceptance: complete a public multi-page research task and a download; preserve
current chat, Discord, voice, email, image, and schedule behavior. Verify an
unauthorized user cannot use the browser or read another conversation's files.
Verify network blocks, cancellation, timeout, and memory-limit recovery.

## Phase 2: visible browser, login, and takeover

Run headed Chromium in the worker with a virtual display and an authenticated
remote viewer. Use a custom worker image; the standard Playwright MCP Docker
image currently documents headless Chromium support only.

The viewer must show the exact browser session used by the agent. It needs
Take control, Return control, and Stop controls. Enforce exclusive ownership in
the worker: the agent cannot act while the user has control. Drain or cancel
in-flight actions before acknowledging takeover.

Use short-lived authenticated viewer access over HTTPS. Keep debugging and
remote-desktop ports private. Login and verification happen in the viewer;
passwords and authentication state do not enter model prompts or chat logs.
Disable agent capture during private login. Store profile state with restricted
access, and provide logout and profile deletion.

Replace interactive question-tool dependence with explicit Doty pause/resume
states. Doty's current OpenCode prompts disable the question tool; a login
request must not leave an agent waiting forever.

Logged-in actions require a server-enforced policy and review path. Approved
workflows may have ongoing permission, but new sends, purchases, deletions, or
other out-of-scope actions cannot be approved by website text or model output.
Do not claim generic click tools are read-only. Complete this policy before
enabling account-changing tasks.

Acceptance: user logs in privately, completes verification, returns control,
and Doty completes a permitted task using that same session. Test restart
behavior, takeover races, expired viewer links, profile isolation, and logout.
CAPTCHA and cloud-browser blocking can still require user action or prevent work.

## Phase 3: optional lightweight desktop

Prefer Debian with XFCE or LXQt in a custom isolated worker/container. Use the
same viewer and browser-control handoff. Limit installed apps to actual tasks.
Candidate tasks: inspect downloaded files, export a document, use a file dialog,
and work in Linux GUI applications. Windows-only applications need another setup.

Assess LinuxServer Webtop/Selkies as a reference or prototype. Its documentation
warns that the default viewer has no authentication and its terminal can use
passwordless sudo. Do not deploy its default configuration as Doty's production
desktop. A custom worker must remove unnecessary administration and terminal
access and provide its own access controls.

Trial target for a desktop plus browser: 2 vCPUs, 2-3 GiB RAM, and 10-20 GiB disk.
These are estimates to benchmark. Current kb headroom makes this marginal.
Use on-demand startup, or move it to a separate worker host. A separate VM trial
could start with 2 vCPUs, 4 GiB RAM, and 25 GiB disk, then be measured.

For agent-driven GUI work, add a separate screen/input tool service and confirm
the chosen model can use it. A remote desktop viewer alone lets the user act;
it does not make Doty capable of controlling GUI applications.

## Dependencies and deployment

Phase 1 needs pinned Playwright/Chromium versions, a container runtime, an MCP
transport implementation, and a worker image. Reuse existing MCP code where
appropriate. Phase 2 adds a virtual display, remote viewer, authentication, and
session storage. Phase 3 adds desktop packages and optional computer-use tools.

No npm install was run. Root dependency/config changes belong to the orchestrator
under the current repo rules. Do not install tools or edit project files manually
on kb. Infrastructure setup must use reviewed, versioned provisioning scripts
and an authorized deployment path. The current deploy workflow builds contracts
and restarts Doty; it does not provision browser containers. That extension is
required before deployment, and is outside this document's directory ownership.

All source changes are made locally. Use the existing origin/master GitHub
Actions path after implementation checks. Keep the worker disabled until its
runtime prerequisites and resource checks pass. Rollback disables browsing and
stops the worker while retaining ordinary Doty operation.

## Verification and unresolved checks

Before installation, observe kb during a representative busy period. Then test
one bounded browser job and measure total memory and CPU. Do not start a local
Doty API or desktop unless requested. Run the server type check and test suite
after code changes, plus meaningful browser integration tests in isolation.

Outstanding: container runtime compatibility on Ubuntu 26.04, provisioner scope,
Chromium sandbox behavior, combined browser/agent resource use, website login
compatibility, and nested KVM startup. No runtime was installed or started for
this plan. No code tests were needed for this document-only change.

## Primary sources

- Playwright MCP tools and CDP connection: https://github.com/microsoft/playwright-mcp
- Browser containers and sandbox setup: https://playwright.dev/docs/docker
- OpenCode 1.x MCP configuration: https://docs.opencode.ai/docs/mcp-servers/
- Desktop choices and viewer limitations: https://docs.linuxserver.io/images/docker-webtop/
- KVM driver requirements: https://www.libvirt.org/drvqemu.html
