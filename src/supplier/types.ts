/**
 * Supplier domain. Suppliers are a second-stage investigation target: a delayed
 * supplier can silently delay every fulfillment that depends on it. Like the
 * Shopify store, the actual supplier system is behind an interface so a mock is
 * swappable for the real integration later — no credentials required today.
 */

export type SupplierRisk = "on_track" | "delayed" | "at_risk";

export interface Supplier {
  id: string;
  name: string;
  contactEmail: string;
  /** The supplier system's own assessment — not invented by the agent. */
  risk: SupplierRisk;
  /** The supplier system's latest expected next-shipment date (ISO), if known. */
  expectedNextShipmentAt?: string | null;
  notes?: string;
}

export interface SupplierDirectory {
  readonly id: string;
  lookupByName(name: string): Promise<Supplier | null>;
  lookupById(id: string): Promise<Supplier | null>;
}