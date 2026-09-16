import type {
  Customer,
  Fulfillment,
  InventoryLevel,
  Order,
  OrderFilter,
  Product,
  TrackingEvent,
} from "./types.ts";
import type { ShopifyAdminClient } from "./client.ts";

/** Deterministic fixture store — no network, no credentials. */
export class MockShopifyClient implements ShopifyAdminClient {
  private readonly orders = new Map<string, Order>();
  private readonly customers = new Map<string, Customer>();
  private readonly products = new Map<string, Product>();
  private readonly fulfillments = new Map<string, Fulfillment>();
  private readonly inventory: InventoryLevel[] = [];

  constructor() {
    this.seed();
  }

  // ── query ──
  async searchOrders(filter: OrderFilter = {}): Promise<Order[]> {
    const rows = [...this.orders.values()].filter((o) => {
      if (filter.status && o.status !== filter.status) return false;
      if (filter.query) {
        const q = filter.query.toLowerCase();
        const hay = [
          o.name,
          o.email ?? "",
          o.lineItems.map((l) => l.title).join(" "),
          o.lineItems.map((l) => l.sku ?? "").join(" "),
        ].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit ? sorted.slice(0, filter.limit) : sorted;
  }

  async getOrder(id: string): Promise<Order | null> {
    return this.orders.get(id) ?? null;
  }

  async getCustomer(ref: { id?: string; email?: string }): Promise<Customer | null> {
    if (ref.id) return this.customers.get(ref.id) ?? null;
    if (ref.email) {
      return (
        [...this.customers.values()].find((c) => c.email.toLowerCase() === ref.email!.toLowerCase()) ?? null
      );
    }
    return null;
  }

  async getProduct(ref: { id?: string; sku?: string }): Promise<Product | null> {
    if (ref.id) return this.products.get(ref.id) ?? null;
    if (ref.sku) {
      return (
        [...this.products.values()].find((p) => p.variants.some((v) => v.sku === ref.sku)) ?? null
      );
    }
    return null;
  }

  async getFulfillment(ref: { orderId?: string; fulfillmentId?: string }): Promise<Fulfillment[]> {
    const rows = [...this.fulfillments.values()];
    if (ref.orderId) return rows.filter((f) => f.orderId === ref.orderId);
    if (ref.fulfillmentId) return rows.filter((f) => f.id === ref.fulfillmentId);
    return rows;
  }

  async getInventory(ref: { productId?: string; inventoryItemId?: string }): Promise<InventoryLevel[]> {
    let rows = this.inventory;
    if (ref.inventoryItemId) rows = rows.filter((i) => i.inventoryItemId === ref.inventoryItemId);
    if (ref.productId) {
      const product = this.products.get(ref.productId);
      if (!product) return [];
      const ids = new Set(product.variants.map((v) => v.inventoryItemId));
      rows = rows.filter((i) => ids.has(i.inventoryItemId));
    }
    return rows;
  }

  // ── write ──
  async addOrderNote(orderId: string, note: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    const next: Order = {
      ...order,
      notes: [...order.notes, note],
      updatedAt: new Date().toISOString(),
    };
    this.orders.set(orderId, next);
    return next;
  }

  // ── fixtures ──
  private seed(): void {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

    const customers: Customer[] = [
      { id: "cust_1", firstName: "Ava", lastName: "Chen", email: "ava@example.com", ordersCount: 3, totalSpent: "214.00" },
      { id: "cust_2", firstName: "Marcus", lastName: "Reed", email: "marcus@example.com", ordersCount: 1, totalSpent: "48.00" },
      { id: "cust_3", firstName: "Priya", lastName: "Shah", email: "priya@example.com", ordersCount: 5, totalSpent: "320.50" },
      { id: "cust_4", firstName: "Liam", lastName: "Novak", email: "liam@example.com", ordersCount: 2, totalSpent: "119.00" },
    ];
    for (const c of customers) this.customers.set(c.id, c);

    const products: Product[] = [
      { id: "prod_1", title: "Aurora Hoodie", handle: "aurora-hoodie", status: "active", tags: ["apparel", "winter"], variants: [{ id: "var_1", title: "Black / M", sku: "HOOD-BLK-M", inventoryItemId: "inv_1" }] },
      { id: "prod_2", title: "Nimbus Tee", handle: "nimbus-tee", status: "active", tags: ["apparel"], variants: [{ id: "var_2", title: "White / L", sku: "TEE-WHT-L", inventoryItemId: "inv_2" }] },
      { id: "prod_3", title: "Stratus Joggers", handle: "stratus-joggers", status: "active", tags: ["apparel"], variants: [{ id: "var_3", title: "Navy / S", sku: "JOG-NAV-S", inventoryItemId: "inv_3" }] },
      { id: "prod_4", title: "Atlas Cap", handle: "atlas-cap", status: "active", tags: ["accessories"], variants: [{ id: "var_4", title: "Khaki / One Size", sku: "CAP-KHAKI", inventoryItemId: "inv_4" }] },
    ];
    for (const p of products) this.products.set(p.id, p);

    this.inventory.push(
      { inventoryItemId: "inv_1", locationId: "loc_1", available: 12 },
      { inventoryItemId: "inv_1", locationId: "loc_2", available: 3 },
      { inventoryItemId: "inv_2", locationId: "loc_1", available: 8 },
      { inventoryItemId: "inv_3", locationId: "loc_1", available: 0 }, // out of stock
      { inventoryItemId: "inv_4", locationId: "loc_1", available: 25 },
    );

    const mkTracking = (events: Array<[TrackingEvent["status"], string | null, number]>): TrackingEvent[] =>
      events.map(([status, location, daysBack]) => ({ status, location, occurredAt: daysAgo(daysBack) }));

    // #1001 — paid, unfulfilled, recent. "Where is my order?"
    this.orders.set("ord_1001", {
      id: "ord_1001", name: "#1001", email: "ava@example.com", status: "open",
      financialStatus: "paid", fulfillmentStatus: "unfulfilled",
      totalPrice: "78.00", currency: "USD", createdAt: daysAgo(2), updatedAt: daysAgo(2),
      notes: [], lineItems: [{ id: "li_1", title: "Aurora Hoodie", sku: "HOOD-BLK-M", quantity: 1, productId: "prod_1" }],
    });

    // #1002 — partially fulfilled, tracking dormant for 9 days. "Shipment delayed / no update".
    this.orders.set("ord_1002", {
      id: "ord_1002", name: "#1002", email: "ava@example.com", status: "open",
      financialStatus: "paid", fulfillmentStatus: "partial",
      totalPrice: "136.00", currency: "USD", createdAt: daysAgo(10), updatedAt: daysAgo(0),
      notes: ["Customer emailed re: no tracking update on 2026-09-03."],
      lineItems: [
        { id: "li_2", title: "Aurora Hoodie", sku: "HOOD-BLK-M", quantity: 1, productId: "prod_1" },
        { id: "li_3", title: "Atlas Cap", sku: "CAP-KHAKI", quantity: 1, productId: "prod_4" },
      ],
    });
    this.fulfillments.set("ful_1", {
      id: "ful_1", orderId: "ord_1002", status: "shipped",
      trackingCompany: "Falcon Parcel", trackingNumber: "1Z-STALE-9DAY", trackingUrl: "https://track.example/1Z-STALE-9DAY",
      trackingEvents: mkTracking([
        ["info_received", null, 10],
        ["shipped", "Bridgeport, CT", 9],
        ["in_transit", "Scranton, PA", 9], // last scan 9 days ago
      ]),
      createdAt: daysAgo(9),
    });

    // #1003 — delivered 2 days ago. "Shows delivered but not received".
    this.orders.set("ord_1003", {
      id: "ord_1003", name: "#1003", email: "marcus@example.com", status: "open",
      financialStatus: "paid", fulfillmentStatus: "fulfilled",
      totalPrice: "48.00", currency: "USD", createdAt: daysAgo(8), updatedAt: daysAgo(2),
      notes: ["2026-09-10: customer reports package marked delivered but not received."],
      lineItems: [{ id: "li_4", title: "Nimbus Tee", sku: "TEE-WHT-L", quantity: 1, productId: "prod_2" }],
    });
    this.fulfillments.set("ful_2", {
      id: "ful_2", orderId: "ord_1003", status: "delivered",
      trackingCompany: "Falcon Parcel", trackingNumber: "1Z-DLV-NOT-RCV", trackingUrl: "https://track.example/1Z-DLV-NOT-RCV",
      trackingEvents: mkTracking([
        ["info_received", null, 7],
        ["shipped", "Bridgeport, CT", 6],
        ["out_for_delivery", "Austin, TX", 2],
        ["delivered", "Austin, TX", 2],
      ]),
      createdAt: daysAgo(6),
    });

    // #1004 — open, paid, unfulfilled for 14 days → stuck in fulfillment.
    this.orders.set("ord_1004", {
      id: "ord_1004", name: "#1004", email: "priya@example.com", status: "open",
      financialStatus: "paid", fulfillmentStatus: "unfulfilled",
      totalPrice: "59.99", currency: "USD", createdAt: daysAgo(14), updatedAt: daysAgo(1),
      notes: [], lineItems: [{ id: "li_5", title: "Stratus Joggers", sku: "JOG-NAV-S", quantity: 1, productId: "prod_3" }],
    });

    // #1005 — cancelled before fulfillment.
    this.orders.set("ord_1005", {
      id: "ord_1005", name: "#1005", email: "liam@example.com", status: "cancelled",
      financialStatus: "voided", fulfillmentStatus: null,
      totalPrice: "25.00", currency: "USD", createdAt: daysAgo(5), updatedAt: daysAgo(4),
      notes: ["Cancelled at customer request before fulfillment."],
      lineItems: [{ id: "li_6", title: "Atlas Cap", sku: "CAP-KHAKI", quantity: 1, productId: "prod_4" }],
    });

    // #1006 — shipped yesterday, healthy movement. Control case.
    this.orders.set("ord_1006", {
      id: "ord_1006", name: "#1006", email: "priya@example.com", status: "open",
      financialStatus: "paid", fulfillmentStatus: "fulfilled",
      totalPrice: "78.00", currency: "USD", createdAt: daysAgo(3), updatedAt: daysAgo(1),
      notes: [], lineItems: [{ id: "li_7", title: "Aurora Hoodie", sku: "HOOD-BLK-M", quantity: 1, productId: "prod_1" }],
    });
    this.fulfillments.set("ful_3", {
      id: "ful_3", orderId: "ord_1006", status: "in_transit",
      trackingCompany: "Falcon Parcel", trackingNumber: "1Z-FRESH-1DAY", trackingUrl: "https://track.example/1Z-FRESH-1DAY",
      trackingEvents: mkTracking([
        ["info_received", null, 2],
        ["shipped", "Bridgeport, CT", 1],
        ["in_transit", "Newark, NJ", 0],
      ]),
      createdAt: daysAgo(1),
    });
  }
}