-- Tasks: the durable unit of agent work. Survives restarts.
CREATE TABLE IF NOT EXISTS tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  input         jsonb NOT NULL,
  result        jsonb,
  error         jsonb,
  current_step  text,
  priority      text,
  attempts      integer NOT NULL DEFAULT 0,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks (type);

-- Audit trail: every tool dispatch, one row per call.
CREATE TABLE IF NOT EXISTS action_logs (
  id           bigserial PRIMARY KEY,
  task_id      uuid REFERENCES tasks(id) ON DELETE CASCADE,
  step         integer NOT NULL,
  tool         text NOT NULL,
  action_kind  text NOT NULL,
  mode         text NOT NULL,
  input        jsonb NOT NULL,
  output       jsonb,
  is_error     boolean NOT NULL DEFAULT false,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_logs_task ON action_logs (task_id, step);

-- Issues: detected operational problems and proactive recommendations.
CREATE TABLE IF NOT EXISTS issues (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL,
  title              text NOT NULL,
  detail             text NOT NULL DEFAULT '',
  severity           text NOT NULL DEFAULT 'info',
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','resolved','escalated')),
  task_id            uuid REFERENCES tasks(id) ON DELETE SET NULL,
  recommended_action jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues (status, created_at DESC);

-- Approvals: human-in-the-loop gates for APPROVAL-tier actions.
CREATE TABLE IF NOT EXISTS approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid REFERENCES tasks(id) ON DELETE CASCADE,
  issue_id     uuid REFERENCES issues(id) ON DELETE SET NULL,
  action_kind  text NOT NULL,
  tool         text NOT NULL,
  rationale    text NOT NULL DEFAULT '',
  input        jsonb,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected')),
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status, created_at DESC);

-- Events: event-oriented ingestion (order_created, shipment_delayed, ...).
CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  source       text NOT NULL DEFAULT '',
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, received_at DESC);