import { z } from "zod";
import type { ToolDefinition, ToolProvider } from "../provider.ts";

/**
 * HIGH-IMPACT business actions. Approval-tier: the agent may PROPOSE these, but
 * the loop only ever records them as pending approvals — it never executes them.
 * Their `execute` bodies intentionally refuse to run outside an approved flow,
 * because the real integrations (refund API, customer email) arrive in later
 * milestones. Human-in-the-loop approval is enforced here, not assumed.
 */

const orderRef = z.object({ orderId: z.string().min(1) });
const refund = z.object({
  orderId: z.string().min(1),
  amount: z.string().optional(),
  reason: z.string().optional(),
});
const disputeSupplier = z.object({
  supplierId: z.string().optional(),
  supplierName: z.string().min(1),
  reference: z.string().optional(),
  reason: z.string().min(1),
});

const MUST_APPROVE =
  "This action requires a recorded human approval and a live business-system integration, neither of which is present. It must never be executed in the agent loop.";

export class BusinessToolProvider implements ToolProvider {
  readonly id = "business";
  readonly label = "Business actions (approval-gated)";

  listTools(): ToolDefinition[] {
    const refuse = (action: string) => () => Promise.reject(new Error(`[${action}] ${MUST_APPROVE}`));

    return [
      {
        name: "business_requestRefund",
        description: "Refund part or all of an order to the customer. Requires human approval.",
        actionKind: "refund",
        inputSchema: refund,
        execute: refuse("refund"),
      },
      {
        name: "business_requestReplacement",
        description: "Ship a replacement for a lost or damaged order. Requires human approval.",
        actionKind: "replacement",
        inputSchema: orderRef,
        execute: refuse("replacement"),
      },
      {
        name: "business_sendCustomerEmail",
        description: "Send a customer-facing email about this order (explanation, next steps). Requires human approval.",
        actionKind: "send_customer_email",
        inputSchema: orderRef,
        execute: refuse("send_customer_email"),
      },
      {
        name: "business_disputeSupplier",
        description:
          "Escalate/raise a dispute with a supplier about a delayed or at-risk shipment (reference the purchase order). Requires human approval.",
        actionKind: "supplier_dispute",
        inputSchema: disputeSupplier,
        execute: refuse("supplier_dispute"),
      },
    ];
  }
}