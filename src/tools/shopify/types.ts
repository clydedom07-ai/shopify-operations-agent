/** Shopify domain shapes as the agent consumes them (snake_case → camelCase). */

export interface LineItem {
  id: string;
  title: string;
  sku: string | null;
  quantity: number;
  productId: string | null;
}

export type OrderStatus = "open" | "closed" | "cancelled";
export type FinancialStatus = "paid" | "pending" | "refunded" | "partially_refunded" | "voided";
export type FulfillmentStatus = "fulfilled" | "partial" | "unfulfilled";

export interface Order {
  id: string;
  name: string; // non-numeric storefront-friendly name, e.g. #1001
  email: string | null;
  status: OrderStatus;
  financialStatus: FinancialStatus;
  fulfillmentStatus: FulfillmentStatus | null;
  totalPrice: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
  notes: string[];
  lineItems: LineItem[];
}

export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ordersCount: number;
  totalSpent: string;
}

export interface ProductVariant {
  id: string;
  title: string;
  sku: string;
  inventoryItemId: string;
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  status: "active" | "draft" | "archived";
  tags: string[];
  variants: ProductVariant[];
}

export type TrackingEventStatus =
  | "info_received"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "attempted_delivery"
  | "delivered"
  | "failure"
  | "exception"
  | "returned";

export interface TrackingEvent {
  status: TrackingEventStatus;
  location: string | null;
  occurredAt: string;
}

export interface Fulfillment {
  id: string;
  orderId: string;
  status: string;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingEvents: TrackingEvent[];
  createdAt: string;
}

export interface InventoryLevel {
  inventoryItemId: string;
  locationId: string;
  available: number;
}

export interface OrderFilter {
  status?: OrderStatus;
  query?: string; // matches order name, customer email, or line-item title
  limit?: number;
}