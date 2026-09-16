import { z } from "zod";
import type { ToolDefinition, ToolProvider } from "../provider.ts";
import type { SupplierDirectory } from "../../supplier/types.ts";

const supplierRef = z
  .object({ name: z.string().optional(), id: z.string().optional() })
  .refine((o) => o.name || o.id, { message: "Provide name or id" });

/**
 * Read-only supplier lookup. Suppliers influence fulfillment timelines, so the
 * agent consults the directory the same way it consults Shopify — the mock is
 * swappable for the real supplier ERP later.
 */
export class SupplierToolProvider implements ToolProvider {
  readonly id = "supplier";
  readonly label = "Suppliers";

  private readonly directory: SupplierDirectory;

  constructor(directory: SupplierDirectory) {
    this.directory = directory;
  }

  listTools(): ToolDefinition[] {
    return [
      {
        name: "supplier_lookup",
        description: "Look up a supplier by name or id: risk status and expected next shipment. Read-only.",
        actionKind: "get_supplier",
        inputSchema: supplierRef,
        execute: (_ctx, args) =>
          typeof args.id === "string" && args.id !== ""
            ? this.directory.lookupById(args.id)
            : this.directory.lookupByName(String(args.name ?? "")),
      },
    ];
  }
}