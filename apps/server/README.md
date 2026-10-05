# Agent runtime

Run the server with `npm -w @doty/server run dev`. Set these environment variables
in your shell (or your existing local dotenv configuration; never commit secrets):

- `OPENAI_MODEL`: required to enable model runs.
- `OPENAI_BASE_URL`: OpenAI-compatible API root, including `/v1` when needed;
  defaults to `https://api.openai.com/v1`.
- `OPENAI_API_KEY`: provider credential; optional for unauthenticated local APIs.

Without `OPENAI_MODEL`, `/message` keeps its original event-only behavior.
`buildApp({ agent: { provider, tools?, persona?, maxSteps? } })` injects a provider
for tests or another worker. Constructing the app never calls the network.

Send `POST /message` with `{"text":"What time is it?"}`. The immediate `202`
response includes `runId`; watch `GET /events` for that run's `run_started`,
`model_step`, `assistant_delta`, `tool_call`, `policy_decision`, `observation`,
`final`, and `run_finished` events. `dot_state` events also drive the existing
avatar contract. Reconnect using `Last-Event-ID` to replay missed steps.

The default limit is **8 model turns**, including the final-answer turn. A run
ending at the limit has status `max_steps`, not a fabricated answer. Tool errors
become observations so the model can recover; provider errors end the run.

## Policy and tools

- `now`: auto-allowed read.
- `http_fetch`: auto-allowed HTTP(S) GET, with private-address and redirect checks,
  a 15-second fetch timeout, and a 1 MB output cap. No model-supplied headers,
  credentials, method, or body. Tool text is untrusted data.
- `artifact_write`: side effect; **pauses with `requires_approval` without writing**.
  The implementation creates immutable files below a lazily allocated temporary
  `doty-artifacts-*` directory, never an arbitrary model-supplied path.
- Dangerous, unknown, or unclassified tools are denied. Classification is owned
  by the server registry, never by model arguments.

Approval UI/resumption, artifact download/retention, persistence, scheduling,
and global concurrency/cost budgets are not implemented. The runner is process-local,
using the existing in-memory EventLog. For deployment, enforce network egress
restrictions: DNS preflight checks alone do **not** prevent DNS rebinding between
validation and native fetch. Do not expose this unauthenticated scaffold publicly.

## Offline verification

```text
npm -w @doty/server run test
npm -w @doty/server run typecheck
```

Runtime tests use a mock provider; provider transport tests use in-memory SSE
responses; HTTP tool tests mock both DNS and fetch. No live API or database is used.
