/**
 * Email transport layer. Emails arrive from any provider (IMAP fetch, a webhook
 * from a hosted inbox, the mock mailbox in dev) and are normalized into
 * InboundEmail before ingestion. The transport is swappable — credentials and
 * real mailboxes come later; today the mock service is deterministic and hard-
 * codes nothing sensitive.
 */

export type InboundEmailKind = "customer" | "supplier";

export interface InboundEmail {
  id: string;
  kind: InboundEmailKind;
  from: { name?: string; address: string };
  to?: string;
  subject: string;
  body: string;
  /** ISO timestamp the mailbox recorded. */
  receivedAt: string;
  /** Supplier emails only: which supplier this is about, as they signed it. */
  supplierName?: string;
  /** Supplier emails only: purchase-order reference, if mentioned. */
  reference?: string;
}

export interface EmailProvider {
  readonly id: string;
  /** Return emails received since the last poll. Never throws the first time. */
  poll(): Promise<InboundEmail[]>;
}