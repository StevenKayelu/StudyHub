/** Shared by next.config and the request proxy, including early error responses. */
export function webSecurityHeaders(production: boolean): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...(production && { 'Strict-Transport-Security': 'max-age=31536000' }),
  };
}

/** Exact origins only: never allow CSP syntax, credentials, paths or wildcard hosts from config. */
export function cspOrigins(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          let url: URL;
          try {
            url = new URL(entry);
          } catch {
            throw new Error(`Invalid CSP origin: ${entry}`);
          }
          const local =
            url.hostname === 'localhost' ||
            url.hostname.endsWith('.localhost') ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '[::1]';
          if (
            (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            url.hostname.includes('*') ||
            /[;'\s]/.test(entry)
          ) {
            throw new Error(
              `CSP sources must be exact HTTPS origins (HTTP allowed only on loopback): ${entry}`,
            );
          }
          return url.origin;
        }),
    ),
  ];
}

const LOCAL_OBJECT_STORE = 'http://127.0.0.1:8333';

export function webContentSecurityPolicy(nonce: string, development: boolean, localHost: boolean): string {
  const connect = cspOrigins(process.env.WEB_CSP_CONNECT_ORIGINS);
  const images = cspOrigins(process.env.WEB_CSP_IMAGE_ORIGINS);
  const media = cspOrigins(process.env.WEB_CSP_MEDIA_ORIGINS);
  const frames = cspOrigins(process.env.WEB_CSP_FRAME_ORIGINS);
  // Local SeaweedFS is used by the production build in local demos too. It is never allowed on a
  // non-loopback school host unless explicitly configured as an origin by the operator.
  // Presigned GETs and brand-asset redirects point there, so images and media need it as well as uploads.
  if (localHost) {
    for (const list of [connect, images, media]) {
      if (!list.includes(LOCAL_OBJECT_STORE)) list.push(LOCAL_OBJECT_STORE);
    }
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    // Dynamic React/Radix/Tiptap styles and branding need inline CSS; this never permits scripts.
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${connect.join(' ')}${development ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    `img-src 'self' data: blob: ${images.join(' ')}`,
    "font-src 'self'",
    `media-src 'self' blob: ${media.join(' ')}`,
    `frame-src ${frames.length === 0 ? "'none'" : frames.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(!development && !localHost ? ['upgrade-insecure-requests'] : []),
  ]
    .map((directive) => directive.trim())
    .join('; ');
}
