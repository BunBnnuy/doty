/**
 * Postgres schema (Drizzle). No live database is required to run the server —
 * this is the durable shape the `PgEventLog` and worker will use.
 *
 * Mirrors the data model in `docs/PLAN.md`:
 *   users · devices · dots · goals · tasks · runs · steps · artifacts ·
 *   memories · integrations · credentials · approvals · schedules ·
 *   notifications · local_actions · harness_sessions · harness_status · events
 *
 * Wave 1 defines the core agent tables plus the append-only `events` log that
 * backs SSE replay. Deliberately single-user today but keyed/owned so it can
 * grow multi-user later.
 */

import {
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { SessionDigest } from '@doty/harness-events';

/** Per-dot spend/step caps (guardrails, PLAN "Cost"). */
export interface DotBudget {
  /** USD, per rolling window. */
  usdPerDay?: number;
  /** Max model/tool steps for a single run. */
  maxStepsPerRun?: number;
  /** Max concurrent runs. */
  maxConcurrentRuns?: number;
}

const id = (): ReturnType<typeof uuid> => uuid('id').primaryKey().defaultRandom();
// Dimension-free pgvector supports different providers. Retrieval checks model and dimensions.
const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as number[],
});

export const dots = pgTable('dots', {
  id: id(),
  /** Nullable today; single-user instance, multi-user-shaped. */
  ownerId: text('owner_id'),
  name: text('name').notNull(),
  avatar: text('avatar'),
  persona: text('persona'),
  autonomy: text('autonomy').notNull().default('manual'),
  budget: jsonb('budget').$type<DotBudget>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const goals = pgTable('goals', {
  id: id(),
  dotId: uuid('dot_id')
    .notNull()
    .references(() => dots.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: id(),
  dotId: uuid('dot_id')
    .notNull()
    .references(() => dots.id, { onDelete: 'cascade' }),
  goalId: uuid('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  /** Wall-clock wake-up for the always-on scheduler. */
  dueAt: timestamp('due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable('runs', {
  id: id(),
  dotId: uuid('dot_id')
    .notNull()
    .references(() => dots.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const steps = pgTable(
  'steps',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** 0-based position within the run. */
    idx: integer('idx').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('running'),
    input: jsonb('input'),
    output: jsonb('output'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('steps_run_id_idx_unique').on(table.runId, table.idx)],
);

/**
 * Append-only event log — the SSE replay source. `seq` is the wire `id` and the
 * `Last-Event-ID` cursor. Rows are never updated or deleted.
 */
export const events = pgTable(
  'events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    /** Payload for the wire `ServerEvent.data`. */
    data: jsonb('data'),
    dotId: uuid('dot_id').references(() => dots.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('events_dot_seq_idx').on(table.dotId, table.seq),
    index('events_run_seq_idx').on(table.runId, table.seq),
  ],
);

export const memories = pgTable('memories', {
  id: id(),
  dotId: uuid('dot_id')
    .notNull()
    .references(() => dots.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('fact'),
  content: text('content').notNull(),
  embedding: embeddingVector('embedding'),
  embeddingModel: text('embedding_model'),
  sourceSessionId: text('source_session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Harness awareness: metadata + client-built digest only. Raw transcripts never
 * reach the server (PLAN "Harness privacy").
 */
export const harnessSessions = pgTable(
  'harness_sessions',
  {
    id: id(),
    harness: text('harness').notNull(),
    sessionId: text('session_id').notNull(),
    project: text('project'),
    title: text('title'),
    status: text('status'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    digest: jsonb('digest').$type<SessionDigest>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('harness_sessions_harness_session_id_unique').on(
      table.harness,
      table.sessionId,
    ),
  ],
);

export const approvals = pgTable('approvals', {
  id: id(),
  dotId: uuid('dot_id').references(() => dots.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
  stepId: uuid('step_id').references(() => steps.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  args: jsonb('args'),
  status: text('status').notNull().default('pending'),
  /** Who approved/denied — audit trail, incl. local-bridge actions. */
  decidedBy: text('decided_by'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

/**
 * Connected third-party accounts (Gmail / Microsoft 365). Multiple accounts
 * per provider are allowed; `(provider, account)` identifies one mailbox.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: id(),
    provider: text('provider').notNull(),
    /** Account email address, shown in status responses. */
    account: text('account'),
    /** Space-separated scopes granted by the provider. */
    scopes: text('scopes'),
    status: text('status').notNull().default('connected'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('integrations_provider_account_unique').on(table.provider, table.account)],
);

/**
 * Sealed OAuth secrets (AES-256-GCM, see `integrations/email/crypto.ts`).
 * Ciphertext only: plaintext tokens never touch the database, logs or model
 * context.
 */
export const credentials = pgTable(
  'credentials',
  {
    id: id(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('oauth_token'),
    secret: text('secret').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('credentials_integration_unique').on(table.integrationId)],
);

// Row/insert types for the worker and routes.
export type Dot = typeof dots.$inferSelect;
export type NewDot = typeof dots.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type HarnessSession = typeof harnessSessions.$inferSelect;
export type NewHarnessSession = typeof harnessSessions.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
