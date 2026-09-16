import type { EmailProvider, InboundEmail } from "./types.ts";

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

/**
 * Deterministic mailbox for dev and tests: three scripted emails (one customer,
 * two suppliers) delivered once, then empty. Mirrors the mock supplier
 * directory — Atlas Textiles is delayed, Brightwave Knits is on track — so the
 * supplier-email path can be exercised end-to-end with no network or creds.
 */
export class MockEmailProvider implements EmailProvider {
  readonly id = "mock";

  private readonly batch: readonly InboundEmail[];
  private drained = false;

  constructor(emails: readonly InboundEmail[] = defaultInbox()) {
    this.batch = emails;
  }

  async poll(): Promise<InboundEmail[]> {
    if (this.drained) return [];
    this.drained = true;
    return [...this.batch];
  }
}

/** Aligns with MockSupplierDirectory: Atlas Textiles (delayed) and Brightwave Knits (on_track). */
export function defaultInbox(): InboundEmail[] {
  return [
    {
      id: "em_customer_1",
      kind: "customer",
      from: { name: "Ava Morgan", address: "ava@example.com" },
      to: "support@shop.example",
      subject: "Where is my order?",
      body: "Hi, I ordered #1001 over a week ago and haven't heard anything. Can you tell me where it is?",
      receivedAt: minutesAgo(40),
    },
    {
      id: "em_supplier_atlas_delay",
      kind: "supplier",
      from: { name: "Atlas Textiles Ops", address: "orders@atlas-textiles.example" },
      to: "ops@shop.example",
      subject: "Re: PO-2026-0142 — shipment is running late",
      body: "Just to confirm on PO-2026-0142: the loom maintenance knocked the whole batch, so the next shipment will be delayed.",
      receivedAt: minutesAgo(25),
      supplierName: "Atlas Textiles",
      reference: "PO-2026-0142",
    },
    {
      id: "em_supplier_brightwave_ok",
      kind: "supplier",
      from: { name: "Brightwave Knits Supply", address: "supply@brightwave-knits.example" },
      to: "ops@shop.example",
      subject: "PO shipment update",
      body: "Heads up that the next knits shipment is on schedule as planned.",
      receivedAt: minutesAgo(10),
      supplierName: "Brightwave Knits",
    },
  ];
}