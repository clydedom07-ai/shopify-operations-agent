/**
 * Generic outbound REST integration.
 *
 * Direction of travel: the agent calls a configured internal/ops REST service
 * (WMS, ERP, logistics) over HTTP. Deliberately lean — one operator-configured
 * base origin, per the "don't over-engineer generic REST yet" constraint. The
 * tool surface is `rest_get` (auto tier) and `rest_write` (approval tier); the
 * deterministic permission split is read-vs-write, never an LLM judgment.
 *
 * Like the n8n webhook client and the Slack notifier, the REST client sits
 * behind an interface — `mock` for hermetic dev/tests, `http` for the real
 * base URL. A response is only ever `ok` when the transport actually returned
 * a 2xx; nothing is fabricated around a failed call.
 */

export type RestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RestRequest {
  /** HTTP method to use. */
  method: RestMethod;
  /** Absolute path below the configured base origin, e.g. "/wms/orders/ord_1001". */
  path: string;
  /** Non-authorization headers to send; may not override content-type. */
  headers?: Record<string, string>;
  /** JSON-serializable payload; encoded as JSON when present. */
  body?: unknown;
}

export interface RestResponse {
  /** True only when the transport returned an HTTP 2xx. */
  ok: boolean;
  /** HTTP status; 0 when no response arrived (timeout/network). */
  status: number;
  /** Parsed JSON body when the response carried one. */
  body?: unknown;
  error?: string;
}

/**
 * Wire contract. The client holds the operator-configured target, so the agent
 * can only ever reach the base origin the deployment authorized — there is no
 * "call any URL" surface.
 */
export interface RestClient {
  readonly id: "mock" | "http";
  request(req: RestRequest): Promise<RestResponse>;
}