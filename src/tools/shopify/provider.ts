import { z } from "zod";
import type { ToolDefinition, ToolProvider } from "../provider.ts";
import type { ShopifyAdminClient } from "./client.ts";

const searchOrders = z.object({
  status: z.enum(["open", "closed", "cancelled"]).optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const idRef = z.object({ id: z.string().min(1) });

const customerRef = z
  .object({ id: z.string().optional(), email: z.string().optional() })
  .refine((o) => o.id || o.email, { message: "Provide id or email" });

const productRef = z
  .object({ id: z.string().optional(), sku: z.string().optional() })
  .refine((o) => o.id || o.sku, { message: "Provide id or sku" });

const fulfillmentRef = z
  .object({ orderId: z.string().optional(), fulfillmentId: z.string().optional() })
  .refine((o) => o.orderId || o.fulfillmentId, { message: "Provide orderId or fulfillmentId" });

const inventoryRef = z
  .object({ productId: z.string().optional(), inventoryItemId: z.string().optional() })
  .refine((o) => o.productId || o.inventoryItemId, { message: "Provide productId or inventoryItemId" });

const addNote = z.object({
  orderId: z.string().min(1),
  note: z.string().min(1),
});

/**
 * The seven Shopify capabilities the agent is built around. Each maps to one
 * method on {@link ShopifyAdminClient} — swap the client, tools stay identical.
 */
export class ShopifyToolProvider implements ToolProvider {
  readonly id = "shopify";

  private readonly client: ShopifyAdminClient;

  constructor(client: ShopifyAdminClient) {
    this.client = client;
  }

  /** Names the live backend so the label is never a claim the deployment
   *  doesn't make ("Shopify (mock)" vs "Shopify (http)"). */
  get label(): string {
    return `Shopify (${this.client.id})`;
  }

  listTools(): ToolDefinition[] {
    return [
      {
        name: "shopify_searchOrders",
        description: "Search Shopify orders by status or free-text query (order name, customer email, line-item title/SKU).",
        actionKind: "search_orders",
        inputSchema: searchOrders,
        execute: (_ctx, args) =>
          this.client.searchOrders({
            status: args.status as "open" | "closed" | "cancelled" | undefined,
            query: args.query as string | undefined,
            limit: args.limit as number | undefined,
          }),
      },
      {
        name: "shopify_getOrder",
        description: "Fetch a single order by id: status, payment, fulfillment, totals, line items, notes.",
        actionKind: "get_order",
        inputSchema: idRef,
        execute: (_ctx, args) => this.client.getOrder(String(args.id)),
      },
      {
        name: "shopify_getCustomer",
        description: "Fetch a customer by id or email: name, email, order count, lifetime spend.",
        actionKind: "get_customer",
        inputSchema: customerRef,
        execute: (_ctx, args) =>
          this.client.getCustomer({
            id: args.id as string | undefined,
            email: args.email as string | undefined,
          }),
      },
      {
        name: "shopify_getProduct",
        description: "Fetch a product by id or SKU, including variants and tags.",
        actionKind: "get_product",
        inputSchema: productRef,
        execute: (_ctx, args) =>
          this.client.getProduct({ id: args.id as string | undefined, sku: args.sku as string | undefined }),
      },
      {
        name: "shopify_getFulfillment",
        description: "Fetch shipments by orderId or fulfillmentId: carrier, tracking number, full tracking-event history.",
        actionKind: "get_fulfillment",
        inputSchema: fulfillmentRef,
        execute: (_ctx, args) =>
          this.client.getFulfillment({
            orderId: args.orderId as string | undefined,
            fulfillmentId: args.fulfillmentId as string | undefined,
          }),
      },
      {
        name: "shopify_getInventory",
        description: "Fetch available inventory levels by product id or inventory item id.",
        actionKind: "get_inventory",
        inputSchema: inventoryRef,
        execute: (_ctx, args) =>
          this.client.getInventory({
            productId: args.productId as string | undefined,
            inventoryItemId: args.inventoryItemId as string | undefined,
          }),
      },
      {
        name: "shopify_addOrderNote",
        description: "Append an internal note to an order (for the operator/audit trail — not visible to customers).",
        actionKind: "add_order_note",
        inputSchema: addNote,
        execute: (_ctx, args) => this.client.addOrderNote(String(args.orderId), String(args.note)),
      },
    ];
  }
}