import type { FastifyInstance } from 'fastify';

/** Applies to successful, framework-error and early-hook responses, including direct API access. */
export function registerSecurityHeadersHook(instance: FastifyInstance, production: boolean): void {
  instance.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    void reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // The only API HTML is a development payment page with CSS and same-origin POST forms, no JS.
    void reply.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (production) void reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}
