import type { Supplier, SupplierDirectory } from "./types.ts";

const daysAhead = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();

/**
 * Deterministic supplier fixture directory — no network, no credentials. In the
 * real system this reads a supplier/ERP table; the agent treats whatever comes
 * back as ground truth (never inventing a risk status or ship date on its own).
 */
export class MockSupplierDirectory implements SupplierDirectory {
  readonly id = "mock";
  private readonly byId = new Map<string, Supplier>();
  private readonly byName = new Map<string, Supplier>();

  constructor() {
    const atlas: Supplier = {
      id: "sup_1",
      name: "Atlas Textiles",
      contactEmail: "orders@atlas-textiles.example",
      risk: "delayed",
      expectedNextShipmentAt: daysAhead(5),
      notes: "Loom maintenance pushed the PO-2026-0142 batch; supplier notified buyer on 2026-09-10.",
    };
    const brightwave: Supplier = {
      id: "sup_2",
      name: "Brightwave Knits",
      contactEmail: "supply@brightwave-knits.example",
      risk: "on_track",
      expectedNextShipmentAt: daysAhead(3),
    };
    for (const s of [atlas, brightwave]) {
      this.byId.set(s.id, s);
      this.byName.set(s.name.toLowerCase(), s);
    }
  }

  async lookupByName(name: string): Promise<Supplier | null> {
    return this.byName.get(name.trim().toLowerCase()) ?? null;
  }

  async lookupById(id: string): Promise<Supplier | null> {
    return this.byId.get(id) ?? null;
  }
}