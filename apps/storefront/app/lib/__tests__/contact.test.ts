import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {clientIp, forwardContact, parseContactForm} from '../contact';

const fields = {
  name: 'Rob',
  email: 'rob@example.com',
  orderNumber: '',
  message: 'Hello there, question here.',
};
const base = {
  opsBaseUrl: 'https://ops.example',
  fields,
  turnstileToken: 'tok',
  honeypot: '',
  ip: '203.0.113.9',
};

describe('parseContactForm', () => {
  it("reads the named fields incl. Turnstile's cf-turnstile-response and the honeypot", () => {
    const fd = new FormData();
    fd.set('name', 'Rob');
    fd.set('email', 'rob@example.com');
    fd.set('orderNumber', '#1001');
    fd.set('message', 'Hello there');
    fd.set('cf-turnstile-response', 'tok');
    fd.set('website', '');
    expect(parseContactForm(fd)).toEqual({
      fields: {
        name: 'Rob',
        email: 'rob@example.com',
        orderNumber: '#1001',
        message: 'Hello there',
      },
      turnstileToken: 'tok',
      honeypot: '',
    });
  });
});

describe('forwardContact', () => {
  it('POSTs JSON to /public/contact and maps 200 → sent', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://ops.example/public/contact');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        ...fields,
        turnstileToken: 'tok',
        honeypot: '',
        ip: '203.0.113.9',
      });
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }) as unknown as typeof fetch;
    await expect(forwardContact({...base, fetchFn})).resolves.toEqual({
      kind: 'sent',
    });
  });

  it('honeypot filled → sent WITHOUT calling ops', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(
      forwardContact({...base, honeypot: 'x', fetchFn}),
    ).resolves.toEqual({kind: 'sent'});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [
      400,
      {ok: false, error: 'validation', fields: {email: 'bad'}},
      {kind: 'validation', fields: {email: 'bad'}},
    ],
    [400, {ok: false, error: 'turnstile'}, {kind: 'turnstile'}],
    [429, {ok: false, error: 'capped'}, {kind: 'capped'}],
    [503, {}, {kind: 'unavailable'}],
    [404, {}, {kind: 'unavailable'}],
  ])('maps %s %j → %j', async (status, body, expected) => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify(body), {status}),
    ) as unknown as typeof fetch;
    await expect(forwardContact({...base, fetchFn})).resolves.toEqual(expected);
  });

  it('network error → unavailable, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    await expect(forwardContact({...base, fetchFn})).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(logged).toHaveBeenCalledWith(
      'contact form: forward failed',
      expect.any(Error),
    );
    logged.mockRestore();
  });
});

describe('clientIp', () => {
  it('prefers cf-connecting-ip, else the first x-forwarded-for hop, else null', () => {
    expect(
      clientIp(
        new Headers({
          'cf-connecting-ip': '1.1.1.1',
          'x-forwarded-for': '2.2.2.2, 3.3.3.3',
        }),
      ),
    ).toBe('1.1.1.1');
    expect(clientIp(new Headers({'x-forwarded-for': '2.2.2.2, 3.3.3.3'}))).toBe(
      '2.2.2.2',
    );
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe('the /contact page source', () => {
  // The route module has no unit test of its own, and the owner constraint is absolute:
  // the public page must never print the support address (bots scraped the last store's).
  it('never prints the support email address', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/routes/contact.tsx'),
      'utf8',
    );
    expect(source).not.toContain('support@');
  });
});
