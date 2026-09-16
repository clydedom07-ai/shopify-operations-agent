import { describe, expect, it } from "vitest";
import { DEFAULT_MODES, PermissionResolver } from "./permissions.ts";
import type { ActionKind } from "./types.ts";

describe("PermissionResolver (deterministic, never LLM-gated)", () => {
  const resolver = new PermissionResolver();

  it("maps read/investigation actions to auto", () => {
    expect(resolver.modeFor("get_order")).toBe("auto");
    expect(resolver.modeFor("search_orders")).toBe("auto");
    expect(resolver.modeFor("get_fulfillment")).toBe("auto");
    expect(resolver.modeFor("get_inventory")).toBe("auto");
    expect(resolver.modeFor("search_email")).toBe("auto");
  });

  it("maps non-risky writes to auto", () => {
    expect(resolver.modeFor("add_order_note")).toBe("auto");
    expect(resolver.modeFor("create_issue")).toBe("auto");
    expect(resolver.modeFor("send_internal_notification")).toBe("auto");
  });

  it("maps financially significant actions to approval", () => {
    expect(resolver.modeFor("refund")).toBe("approval");
    expect(resolver.modeFor("replacement")).toBe("approval");
    expect(resolver.modeFor("discount")).toBe("approval");
    expect(resolver.modeFor("order_modification")).toBe("approval");
    expect(resolver.modeFor("supplier_dispute")).toBe("approval");
    expect(resolver.modeFor("policy_exception")).toBe("approval");
    expect(resolver.modeFor("send_customer_email")).toBe("approval");
  });

  it("maps destructive / credential actions to blocked", () => {
    expect(resolver.modeFor("access_credentials")).toBe("blocked");
    expect(resolver.modeFor("destructive")).toBe("blocked");
  });

  it("defaults unknown kinds to blocked (fail closed)", () => {
    expect(resolver.modeFor("anything_else" as unknown as ActionKind)).toBe("blocked");
  });

  it("never treats approval/blocked as runnable without a decision", () => {
    expect(resolver.canRun("get_order", "auto")).toBe(true);
    expect(resolver.canRun("refund", "approval")).toBe(false);
    expect(resolver.canRun("refund", "blocked")).toBe(false);
    expect(resolver.canRun("access_credentials", "auto")).toBe(false);
  });

  it("is a static table — confidence is not an input", () => {
    // The resolver's behavior is fully determined by the action kind. There is
    // no pathway through which a model-supplied probability could reach it.
    const table = { ...DEFAULT_MODES };
    expect(Object.values(table).every((m) => m === "auto" || m === "approval" || m === "blocked")).toBe(true);
  });

  it("supports deterministic per-org overrides", () => {
    const strict = resolver.withModes({ add_order_note: "approval" });
    expect(strict.modeFor("add_order_note")).toBe("approval");
    expect(resolver.modeFor("add_order_note")).toBe("auto"); // base unchanged
  });
});