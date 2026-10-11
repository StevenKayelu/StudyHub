import type { Logger } from 'pino';
import { z } from 'zod';

import type { JobEnvelope } from './job-envelope';

/** A no-op job proving the queue, worker and envelope validation work end to end. */
export const HEARTBEAT_JOB = 'system.heartbeat';

export const heartbeatPayloadSchema = z.object({
  sentAt: z.iso.datetime(),
});

export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;

export interface HeartbeatResult {
  receivedAt: string;
}

export async function handleHeartbeat(envelope: JobEnvelope, logger: Logger): Promise<HeartbeatResult> {
  const payload = heartbeatPayloadSchema.parse(envelope.payload);
  const receivedAt = new Date().toISOString();
  // The worker passes a child logger already bound to the envelope's requestId.
  logger.info({ job: envelope.type, sentAt: payload.sentAt }, 'Heartbeat processed');
  return { receivedAt };
}
