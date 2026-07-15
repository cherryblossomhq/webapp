import type { IncomingMessage, ServerResponse } from "node:http";

/** Same-origin CORS proxy handler — see proxy.mjs. */
export default function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void>;
