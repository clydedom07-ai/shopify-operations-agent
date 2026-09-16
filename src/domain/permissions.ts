import type { ActionKind, PermissionMode } from "./types.ts";

/**
 * Deterministic permission resolution.
 *
 * Rules are a static mapping from action kind → mode. The LLM never decides
 * what is authorized: it proposes an action kind, and THIS table decides.
 * Model confidence / self-reported capability is never an authorization input.
 */

export const DEFAULT_MODES: Readonly<Record<ActionKind, PermissionMode>> = {
  // read / investigate — automatic
  search_orders: "auto",
  get_order: "auto",
  get_customer: "auto",
  get_product: "auto",
  get_fulfillment: "auto",
  get_inventory: "auto",
  get_supplier: "auto",
  search_email: "auto",
  // non-risky writes — automatic
  add_order_note: "auto",
  create_issue: "auto",
  supplier_delay: "auto",
  send_routine_customer_update: "auto",
  send_internal_notification: "auto",
  trigger_n8n_workflow: "auto",
  slack_post_message: "auto",
  rest_http_get: "auto",
  // significant actions — require human approval
  refund: "approval",
  replacement: "approval",
  discount: "approval",
  order_modification: "approval",
  supplier_dispute: "approval",
  policy_exception: "approval",
  send_customer_email: "approval",
  rest_http_write: "approval",
  // never allowed — destructive / out of scope
  access_credentials: "blocked",
  destructive: "blocked",
};

export class PermissionResolver {
  private readonly modes: Readonly<Record<ActionKind, PermissionMode>>;

  constructor(modes: Readonly<Record<ActionKind, PermissionMode>> = DEFAULT_MODES) {
    this.modes = modes;
  }

  modeFor(kind: ActionKind): PermissionMode {
    return this.modes[kind] ?? "blocked";
  }

  canRun(kind: ActionKind, mode: PermissionMode): boolean {
    if (mode === "blocked") return false;
    if (mode === "approval") return false; // requires a recorded human approval
    return this.modeFor(kind) === "auto";
  }

  /** A resolver with specific kinds overridden (e.g. tests, or org config). */
  withModes(overrides: Partial<Record<ActionKind, PermissionMode>>): PermissionResolver {
    return new PermissionResolver({ ...this.modes, ...overrides });
  }
}