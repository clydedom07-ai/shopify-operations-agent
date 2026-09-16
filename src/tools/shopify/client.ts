import type {
  Customer,
  Fulfillment,
  InventoryLevel,
  Order,
  OrderFilter,
  Product,
} from "./types.ts";

/**
 * The Shopify boundary. The agent depends only on this interface — the mock
 * implementation is used today; swap in a live Admin-API client later without
 * touching the agent, the tools, or their tests.
 */
export interface ShopifyAdminClient {
  searchOrders(filter: OrderFilter): Promise<Order[]>;
  getOrder(id: string): Promise<Order | null>;
  getCustomer(ref: { id?: string; email?: string }): Promise<Customer | null>;
  getProduct(ref: { id?: string; sku?: string }): Promise<Product | null>;
  getFulfillment(ref: { orderId?: string; fulfillmentId?: string }): Promise<Fulfillment[]>;
  getInventory(ref: { productId?: string; inventoryItemId?: string }): Promise<InventoryLevel[]>;
  addOrderNote(orderId: string, note: string): Promise<Order>;
}