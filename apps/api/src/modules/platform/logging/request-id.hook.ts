import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Incoming ids are reused only if they are short, opaque and safe to log and echo. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Fastify `genReqId`: reuse a valid incoming X-Request-Id, otherwise generate `req_<uuid>`. */
export function genReqId(request: IncomingMessage): string {
  const header = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : `req_${randomUUID()}`;
}

/** Echo the request id on every response, including error responses. */
export function registerRequestIdHook(instance: FastifyInstance): void {
  instance.addHook('onSend', async (request, reply, payload) => {
    void reply.header('X-Request-Id', request.id);
    return payload;
  });
}
