export interface ContactFields {
  name: string;
  email: string;
  orderNumber: string;
  message: string;
}

export type ContactResult =
  | {kind: 'sent'}
  | {kind: 'validation'; fields: Record<string, string>}
  | {kind: 'turnstile'}
  | {kind: 'capped'}
  | {kind: 'unavailable'};

const str = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
};

export function parseContactForm(form: FormData) {
  return {
    fields: {
      name: str(form, 'name'),
      email: str(form, 'email'),
      orderNumber: str(form, 'orderNumber'),
      message: str(form, 'message'),
    },
    turnstileToken: str(form, 'cf-turnstile-response'),
    honeypot: str(form, 'website'),
  };
}

export function clientIp(headers: Headers): string | null {
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim() || null;
  return null;
}

/** Proxies the submission to ops (contact-form spec §1). The honeypot is checked here too: a bot
 * that filled it gets the success page without ops ever hearing about it. */
export async function forwardContact(input: {
  opsBaseUrl: string;
  fields: ContactFields;
  turnstileToken: string;
  honeypot: string;
  ip: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<ContactResult> {
  if (input.honeypot.trim() !== '') return {kind: 'sent'};
  const fetchFn = input.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`${input.opsBaseUrl}/public/contact`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        ...input.fields,
        turnstileToken: input.turnstileToken,
        honeypot: input.honeypot,
        ip: input.ip,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    if (res.status === 200) return {kind: 'sent'};
    if (res.status === 429) return {kind: 'capped'};
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
      };
      if (body.error === 'validation')
        return {kind: 'validation', fields: body.fields ?? {}};
      if (body.error === 'turnstile') return {kind: 'turnstile'};
    }
    return {kind: 'unavailable'};
  } catch (err) {
    // Timeout, DNS failure, ops down — the customer sees the unavailable copy either way,
    // but the Oxygen log needs the cause.
    console.error('contact form: forward failed', err);
    return {kind: 'unavailable'};
  }
}
