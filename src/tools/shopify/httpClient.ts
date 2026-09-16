import type { ShopifyAdminClient } from "./client.ts";
import type {
  Customer,
  FinancialStatus,
  Fulfillment,
  InventoryLevel,
  Order,
  OrderFilter,
  OrderStatus,
  Product,
  TrackingEventStatus,
} from "./types.ts";

/**
 * Raw Shopify Admin REST shapes, exactly as the API returns them (snake_case),
 * before the mapper normalizes into the camelCase domain types.
 */
interface AdminLineItem {
  id: number;
  title: string;
  sku: string | null;
  quantity: number;
  product_id: number | null;
}
interface AdminOrder {
  id: number;
  name: string | null;
  email: string | null;
  status: OrderStatus;
  financial_status: FinancialStatus;
  fulfillment_status: Order["fulfillmentStatus"];
  total_price: string;
  currency: string;
  created_at: string;
  updated_at: string;
  note: string | null;
  line_items: AdminLineItem[];
}
interface AdminCustomer {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  orders_count: number;
  total_spent: string;
}
interface AdminVariant {
  id: number;
  title: string;
  sku: string;
  inventory_item_id: string;
}
interface AdminProduct {
  id: number;
  title: string;
  handle: string;
  status: "active" | "draft" | "archived";
  /** REST returns tags as a single comma-separated string, not an array. */
  tags: string | string[];
  variants: AdminVariant[];
}
interface AdminTrackingEvent {
  status: string;
  location: string | null;
  occurred_at: string;
}
interface AdminFulfillment {
  id: number;
  order_id: number;
  status: string;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  created_at: string;
  tracking_events: AdminTrackingEvent[];
}
interface AdminInventoryLevel {
  inventory_item_id: string;
  location_id: string;
  available: number;
}

/**
 * Live Shopify Admin REST client. The agent keeps depending on
 * {@link ShopifyAdminClient}; this implementation talks to a store's Admin API
 * with the Admin access token on every request and maps the snake_case JSON
 * back into the domain shapes.
 *
 * Failure discipline: a read that errors, times out, or returns non-2xx yields
 * `null` / `[]` — an honest "nothing found", never a fabricated order. The one
 * write ({@link addOrderNote}) throws on failure so the registry audits it as
 * an errored tool call. Nothing the agent can quote is ever invented.
 *
 * Known honest limits (Admin REST has no global listing for these): finding a
 * fulfillment by id alone, and finding a product by SKU beyond the first page
 * of products — both answer `null`/`[]` rather than guess.
 */
export class HttpShopifyClient implements ShopifyAdminClient {
  readonly id = "http" as const;
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(store: string, accessToken: string, apiVersion = "2024-10", timeoutMs = 5_000) {
    // Accept "shop.myshopify.com" or a full https URL.
    const host = store.includes("://") ? store : `https://${store}`;
    this.base = `${host.replace(/\/+$/, "")}/admin/api/${apiVersion}`;
    this.token = accessToken;
    this.timeoutMs = timeoutMs;
  }

  async searchOrders(filter: OrderFilter = {}): Promise<Order[]> {
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.query) params.set("query", filter.query);
    if (filter.limit) params.set("limit", String(filter.limit));
    const data = await this.get<{ orders: AdminOrder[] }>(`/orders.json?${params}`);
    return (data?.orders ?? []).map(mapOrder);
  }

  async getOrder(id: string): Promise<Order | null> {
    const data = await this.get<{ order: AdminOrder }>(`/orders/${encodeURIComponent(id)}.json`);
    return data?.order ? mapOrder(data.order) : null;
  }

  async getCustomer(ref: { id?: string; email?: string }): Promise<Customer | null> {
    if (ref.id) {
      const data = await this.get<{ customer: AdminCustomer }>(`/customers/${encodeURIComponent(ref.id)}.json`);
      return data?.customer ? mapCustomer(data.customer) : null;
    }
    if (ref.email) {
      const data = await this.get<{ customers: AdminCustomer[] }>(
        `/customers/search.json?query=${encodeURIComponent(`email:${ref.email}`)}`,
      );
      const first = data?.customers?.[0];
      return first ? mapCustomer(first) : null;
    }
    return null;
  }

  async getProduct(ref: { id?: string; sku?: string }): Promise<Product | null> {
    if (ref.id) {
      const data = await this.get<{ product: AdminProduct }>(`/products/${encodeURIComponent(ref.id)}.json`);
      return data?.product ? mapProduct(data.product) : null;
    }
    if (ref.sku) {
      const data = await this.get<{ products: AdminProduct[] }>(
        `/products.json?limit=250&fields=id,title,handle,status,tags,variants`,
      );
      const hit = data?.products?.find((p) => p.variants.some((v) => v.sku === ref.sku));
      return hit ? mapProduct(hit) : null;
    }
    return null;
  }

  async getFulfillment(ref: { orderId?: string; fulfillmentId?: string }): Promise<Fulfillment[]> {
    if (ref.orderId) {
      const data = await this.get<{ fulfillments: AdminFulfillment[] }>(
        `/orders/${encodeURIComponent(ref.orderId)}/fulfillments.json`,
      );
      return (data?.fulfillments ?? []).map(mapFulfillment);
    }
    // No global fulfillments list in the Admin REST API — a fulfillment id alone
    // can't be resolved to a parent order. Answer nothing, honestly.
    return [];
  }

  async getInventory(ref: { productId?: string; inventoryItemId?: string }): Promise<InventoryLevel[]> {
    let ids: string;
    if (ref.inventoryItemId) {
      ids = ref.inventoryItemId;
    } else if (ref.productId) {
      const product = await this.getProduct({ id: ref.productId });
      const itemIds = product?.variants.map((v) => v.inventoryItemId);
      if (!itemIds || itemIds.length === 0) return [];
      ids = itemIds.join(",");
    } else {
      return [];
    }
    const data = await this.get<{ inventory_levels: AdminInventoryLevel[] }>(
      `/inventory_levels.json?inventory_item_ids=${encodeURIComponent(ids)}`,
    );
    return (data?.inventory_levels ?? []).map(mapInventoryLevel);
  }

  async addOrderNote(orderId: string, note: string): Promise<Order> {
    const current = await this.getOrder(orderId);
    if (!current) throw new Error(`Order not found: ${orderId}`);
    const combined = current.notes.length > 0 ? [...current.notes, note].join("\n") : note;
    const res = await this.fetchWithTimeout(`/orders/${encodeURIComponent(orderId)}.json`, "PUT", {
      order: { note: combined },
    });
    if (!res.ok) throw new Error(`Shopify addOrderNote failed: HTTP ${res.status}`);
    const data = (await res.json()) as { order: AdminOrder };
    return mapOrder(data.order);
  }

  // ── transport ──

  private async get<T>(path: string): Promise<T | null> {
    try {
      const res = await this.fetchWithTimeout(path, "GET");
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  private fetchWithTimeout(path: string, method: "GET" | "PUT", body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        "x-shopify-access-token": this.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  }
}

// ── field mappers ──

function mapOrder(o: AdminOrder): Order {
  return {
    id: String(o.id),
    name: o.name ?? `#${o.id}`,
    email: o.email ?? null,
    status: o.status,
    financialStatus: o.financial_status,
    fulfillmentStatus: o.fulfillment_status,
    totalPrice: o.total_price,
    currency: o.currency,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    // The Admin API stores one basic note; writes join notes with "\n", so
    // splitting restores the domain's array shape faithfully.
    notes: o.note ? o.note.split("\n").filter(Boolean) : [],
    lineItems: (o.line_items ?? []).map((li) => ({
      id: String(li.id),
      title: li.title,
      sku: li.sku ?? null,
      quantity: li.quantity,
      productId: li.product_id == null ? null : String(li.product_id),
    })),
  };
}

function mapCustomer(c: AdminCustomer): Customer {
  return {
    id: String(c.id),
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    ordersCount: c.orders_count,
    totalSpent: c.total_spent,
  };
}

function mapProduct(p: AdminProduct): Product {
  return {
    id: String(p.id),
    title: p.title,
    handle: p.handle,
    status: p.status,
    // REST delivers tags as "a, b" — normalize to the domain's array.
    tags: (Array.isArray(p.tags) ? p.tags : p.tags.split(",")).map((t) => t.trim()).filter(Boolean),
    variants: (p.variants ?? []).map((v) => ({
      id: String(v.id),
      title: v.title,
      sku: v.sku,
      inventoryItemId: v.inventory_item_id,
    })),
  };
}

function mapFulfillment(f: AdminFulfillment): Fulfillment {
  return {
    id: String(f.id),
    orderId: String(f.order_id),
    status: f.status,
    trackingCompany: f.tracking_company ?? null,
    trackingNumber: f.tracking_number ?? null,
    trackingUrl: f.tracking_url ?? null,
    createdAt: f.created_at,
    trackingEvents: (f.tracking_events ?? []).map((e) => ({
      status: e.status as TrackingEventStatus,
      location: e.location ?? null,
      occurredAt: e.occurred_at,
    })),
  };
}

function mapInventoryLevel(i: AdminInventoryLevel): InventoryLevel {
  return {
    inventoryItemId: i.inventory_item_id,
    locationId: i.location_id,
    available: i.available,
  };
}