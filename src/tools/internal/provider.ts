import { z } from "zod";
import type { ToolDefinition, ToolProvider } from "../provider.ts";

const createIssue = z.object({
  kind: z.string().min(1).default("operations"),
  title: z.string().min(1),
  detail: z.string().default(""),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
});

const recordSupplierDelay = z.object({
  supplierId: z.string().optional(),
  supplierName: z.string().min(1),
  reference: z.string().optional(),
  detail: z.string().default(""),
});

/**
 * Agent-internal tools — operations the agent may perform inside its own
 * domain (filing issues, recording detected-delay events), as opposed to
 * business-system integrations.
 */
export class InternalToolProvider implements ToolProvider {
  readonly id = "internal";
  readonly label = "Internal";

  listTools(): ToolDefinition[] {
    return [
      {
        name: "internal_createIssue",
        description: "File an internal operational issue/finding for human follow-up. Not customer-facing.",
        actionKind: "create_issue",
        inputSchema: createIssue,
        execute: (ctx, args) =>
          ctx.repo.createIssue({
            kind: (args.kind as string | undefined) ?? "operations",
            title: String(args.title),
            detail: String(args.detail ?? ""),
            severity: (args.severity as "info" | "warning" | "critical") ?? "warning",
            taskId: ctx.taskId,
            recommendedAction: null,
          }),
      },
      {
        name: "internal_recordSupplierDelay",
        description:
          "Record a supplier_delay_detected event once a supplier delay is confirmed from supplier data. Pure audit: files no customer-facing thing.",
        actionKind: "supplier_delay",
        inputSchema: recordSupplierDelay,
        execute: (ctx, args) =>
          ctx.repo.recordEvent({
            type: "supplier_delay_detected",
            source: "agent",
            payload: {
              supplierId: (args.supplierId as string | undefined) ?? null,
              supplierName: String(args.supplierName),
              reference: (args.reference as string | undefined) ?? null,
              detail: String(args.detail ?? ""),
            },
          }),
      },
    ];
  }
}