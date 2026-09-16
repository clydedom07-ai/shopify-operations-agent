import type { Logger } from "../lib/logger.ts";
import type { Repository } from "../domain/repository.ts";
import type { InboundEmail } from "./types.ts";

export interface IngestResult {
  read: number;
  skipped: number;
  tasks: Array<{ taskId: string; type: string; emailId: string }>;
}

/**
 * Turn inbound emails into the same event→task pipeline the API uses: an email
 * of any kind is recorded as an event, then a task is queued for the agent.
 * Re-ingestion is avoided by checking the event log for a matching emailId, so
 * the mock mailbox draining (or a restart) never double-processes an email.
 */
export async function ingestInbound(emails: InboundEmail[], repo: Repository, logger: Logger): Promise<IngestResult> {
  const result: IngestResult = { read: emails.length, skipped: 0, tasks: [] };

  for (const email of emails) {
    const seen = await hasEmailEvent(repo, email.id);
    if (seen) {
      result.skipped += 1;
      continue;
    }

    if (email.kind === "customer") {
      const ts = {
        type: "customer_email_received" as const,
        payload: {
          emailId: email.id,
          from: email.from.address,
          fromName: email.from.name ?? null,
          subject: email.subject,
          receivedAt: email.receivedAt,
        },
        source: "email",
      };
      await repo.recordEvent(ts);
      const task = await repo.createTask({
        type: "customer-email",
        priority: "high",
        input: {
          text: `${email.subject}\n\n${email.body}`,
          customerEmail: email.from.address,
          eventType: "customer_email_received",
          metadata: { emailId: email.id, receivedAt: email.receivedAt },
        },
      });
      result.tasks.push({ taskId: task.id, type: task.type, emailId: email.id });
      logger.info({ emailId: email.id, taskId: task.id }, "ingested customer email");
    } else {
      const supplierName = email.supplierName ?? email.from.name ?? email.from.address;
      const ts = {
        type: "supplier_email_received" as const,
        payload: {
          emailId: email.id,
          from: email.from.address,
          fromName: email.from.name ?? null,
          subject: email.subject,
          supplierName,
          reference: email.reference ?? null,
          receivedAt: email.receivedAt,
        },
        source: "email",
      };
      await repo.recordEvent(ts);
      const task = await repo.createTask({
        type: "supplier-email",
        priority: "medium",
        input: {
          text: `${email.subject}\n\n${email.body}`,
          eventType: "supplier_email_received",
          metadata: {
            emailId: email.id,
            supplierName,
            reference: email.reference ?? null,
            receivedAt: email.receivedAt,
          },
        },
      });
      result.tasks.push({ taskId: task.id, type: task.type, emailId: email.id });
      logger.info({ emailId: email.id, taskId: task.id, supplierName }, "ingested supplier email");
    }
  }

  return result;
}

async function hasEmailEvent(repo: Repository, emailId: string): Promise<boolean> {
  const events = (await repo.listEvents({ limit: 500 })).filter(
    (e) => e.type === "customer_email_received" || e.type === "supplier_email_received",
  );
  return events.some((e) => e.payload["emailId"] === emailId);
}