import {render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import type {ContactResult} from '~/lib/contact';

type ActionData = {
  result: ContactResult;
  values: {
    name: string;
    email: string;
    orderNumber: string;
    message: string;
  } | null;
};

const state: {enabled: boolean; data: ActionData | undefined} = {
  enabled: true,
  data: undefined,
};

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Form: ({
      children,
      ...rest
    }: {children?: React.ReactNode; [key: string]: unknown}) => (
      <form {...rest}>{children}</form>
    ),
    useLoaderData: () => ({siteKey: 'site-key', enabled: state.enabled}),
    useActionData: () => state.data,
    useNavigation: () => ({state: 'idle'}),
  };
});
vi.mock('@shopify/hydrogen', () => ({useNonce: () => 'test-nonce'}));

const {default: Contact, action} = await import('../contact');

const TYPED = {
  name: 'Rob',
  email: 'rob@example.com',
  orderNumber: '#1001',
  message: 'My doge chewed the pad, help.',
};

describe('/contact — unavailable result', () => {
  it('keeps the form mounted, restores the typed values and shows an alert banner', () => {
    state.enabled = true;
    state.data = {result: {kind: 'unavailable'}, values: TYPED};
    render(<Contact />);

    expect(screen.getByRole('alert').textContent).toMatch(/temporarily unavailable/i);
    // The form is still there, with everything the customer typed.
    expect(screen.getByRole('button', {name: /send message/i})).toBeInTheDocument();
    expect(screen.getByLabelText(/message/i)).toHaveValue(TYPED.message);
    expect(screen.getByLabelText(/^name/i)).toHaveValue(TYPED.name);
    expect(screen.getByLabelText(/email/i)).toHaveValue(TYPED.email);
    expect(screen.getByLabelText(/order number/i)).toHaveValue(TYPED.orderNumber);
  });

  it('resets the single-use Turnstile widget (its token was consumed)', () => {
    state.enabled = true;
    state.data = {result: {kind: 'unavailable'}, values: TYPED};
    const reset = vi.fn();
    (window as unknown as {turnstile: {reset: () => void}}).turnstile = {reset};
    render(<Contact />);
    expect(reset).toHaveBeenCalled();
  });

  it('a DISABLED form (no keys configured) still replaces the whole page', () => {
    state.enabled = false;
    state.data = undefined;
    render(<Contact />);
    expect(screen.queryByRole('button', {name: /send message/i})).toBeNull();
    expect(document.body.textContent).toMatch(/temporarily unavailable/i);
  });

  it('the honeypot wrapper is inert (not aria-hidden around a focusable input)', () => {
    state.enabled = true;
    state.data = undefined;
    const {container} = render(<Contact />);
    const honeypot = container.querySelector('input[name="website"]');
    expect(honeypot).not.toBeNull();
    const wrapper = honeypot!.closest('div');
    expect(wrapper!.hasAttribute('inert')).toBe(true);
    expect(wrapper!.hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('/contact action', () => {
  it("returns the typed values with an 'unavailable' result so nothing is lost", async () => {
    const form = new FormData();
    form.set('name', TYPED.name);
    form.set('email', TYPED.email);
    form.set('orderNumber', TYPED.orderNumber);
    form.set('message', TYPED.message);
    form.set('cf-turnstile-response', 'tok');
    form.set('website', '');
    const request = new Request('https://shop.example/contact', {
      method: 'POST',
      body: form,
    });

    // ops unreachable → 'unavailable'
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchFn);
    try {
      const res = (await action({
        request,
        context: {env: {OPS_BASE_URL: 'https://ops.example'}},
        params: {},
      } as unknown as Parameters<typeof action>[0])) as ActionData;
      expect(res.result).toEqual({kind: 'unavailable'});
      expect(res.values).toEqual(TYPED);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('returns the typed values when OPS_BASE_URL is missing too', async () => {
    const form = new FormData();
    form.set('name', TYPED.name);
    form.set('email', TYPED.email);
    form.set('orderNumber', TYPED.orderNumber);
    form.set('message', TYPED.message);
    const res = (await action({
      request: new Request('https://shop.example/contact', {
        method: 'POST',
        body: form,
      }),
      context: {env: {}},
      params: {},
    } as unknown as Parameters<typeof action>[0])) as ActionData;
    expect(res.result).toEqual({kind: 'unavailable'});
    expect(res.values).toEqual(TYPED);
  });
});
