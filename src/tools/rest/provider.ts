import { z } from "zod";
import type { ToolDefinition, ToolProvider } from "../provider.ts";
import type { RestClient, RestMethod, RestRequest } from "../../rest/types.ts";

const restGetSchema = z.object({
  /** Absolute path below the configured base origin, e.g. "/wms/orders/ord_1001". */
  path: z.string().min(1).max(2048),
  headers: z.record(z.string(), z.string()).optional().default({}),
});
const restWriteSchema = z.object({
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(2048),
  headers: z.record(z.string(), z.string()).optional().default({}),
  body: z.unknown().optional(),
});

/**
 * Generic outbound REST tool provider. Two tools, one deterministic rule:
 * reads (`rest_get`) are auto — a GET that lists or confirms state is exactly
 * the investigation the agent already does — while any write (`rest_write`)
 * is approval-tier, mirroring the "reads auto, significant actions human-
 * gated" policy. No other surface exists: the client holds the configured
 * base origin, so the agent can only reach the service the deployment
 * authorized. A call is `ok` only when the transport returned a 2xx; a failed
 * call is reported honestly, never wrapped as a success.
 */
export class RestToolProvider implements ToolProvider {
  readonly id = "rest";
  readonly label = "Generic REST (ops services)";

  private readonly client: RestClient;

  constructor(client: RestClient) {
    this.client = client;
  }

  listTools(): ToolDefinition[] {
    return [
      {
        name: "rest_get",
        description:
          "GET a resource from the configured internal service (path below the base origin). Read-only, auto-tier — returns { ok, status, body }.",
        actionKind: "rest_http_get",
        inputSchema: restGetSchema,
        execute: (_ctx, args) => {
          const headers = (args.headers ?? {}) as Record<string, string>;
          const req: RestRequest = { method: "GET", path: String(args.path), ...(Object.keys(headers).length > 0 ? { headers } : {}) };
          return this.client.request(req).then((out) =>
            out.ok
              ? { ok: true, status: out.status, body: out.body ?? null, client: this.client.id }
              : { ok: false, status: out.status, error: out.error },
          );
        },
      },
      {
        name: "rest_write",
        description:
          "POST/PUT/PATCH/DELETE a resource on the configured internal service (path below the base origin). Approval-tier: never runs until a recorded human approval authorizes this exact write. Returns { ok, status, body }.",
        actionKind: "rest_http_write",
        inputSchema: restWriteSchema,
        execute: (_ctx, args) => {
          const headers = (args.headers ?? {}) as Record<string, string>;
          const req: RestRequest = {
            method: String(args.method) as RestMethod,
            path: String(args.path),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
          };
          return this.client.request(req).then((out) =>
            out.ok
              ? { ok: true, status: out.status, body: out.body ?? null, client: this.client.id }
              : { ok: false, status: out.status, error: out.error },
          );
        },
      },
    ];
  }
}