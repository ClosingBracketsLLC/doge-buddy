/**
 * Redacts the VALUE of any `t` query parameter (the magic-link and one-click action tokens
 * carried by `/admin/login/consume?t=...` and `/a/:id/approve|reject?t=...`) so a raw secret
 * never lands in Fastify's request logs, which the hosting platform retains. Matches `t` only
 * when it's an actual param name — immediately preceded by `?` or `&` and followed by `=` — so
 * a `t` that only appears inside another param's name or value (e.g. `?not=at=3`) is untouched.
 * Every other query param, and URLs with no `t` param at all, pass through unchanged.
 */
export function redactTokenParam(url: string): string {
  return url.replace(/([?&]t=)[^&]*/g, '$1[redacted]')
}
