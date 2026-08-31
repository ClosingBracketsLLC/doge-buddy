import {useEffect} from 'react';
import {Form, useActionData, useLoaderData, useNavigation} from 'react-router';
import {useNonce} from '@shopify/hydrogen';
import type {Route} from './+types/contact';
import {
  clientIp,
  forwardContact,
  parseContactForm,
  type ContactResult,
} from '~/lib/contact';

export const meta: Route.MetaFunction = () => [{title: 'Contact — Doge Buddy'}];

export async function loader({context}: Route.LoaderArgs) {
  const siteKey = context.env.PUBLIC_TURNSTILE_SITE_KEY ?? '';
  const enabled = Boolean(siteKey && context.env.OPS_BASE_URL);
  return {siteKey, enabled};
}

export async function action({request, context}: Route.ActionArgs) {
  const opsBaseUrl = context.env.OPS_BASE_URL;
  // Parsed BEFORE the config check so every non-'sent' result — 'unavailable' included — can hand
  // the typed values back to the re-rendered form (see the banner below).
  const parsed = parseContactForm(await request.formData());
  if (!opsBaseUrl)
    return {
      result: {kind: 'unavailable'} as ContactResult,
      values: parsed.fields,
    };
  const result = await forwardContact({
    opsBaseUrl,
    ...parsed,
    ip: clientIp(request.headers),
  });
  return {result, values: result.kind === 'sent' ? null : parsed.fields};
}

const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js';

/** The api.js global. Typed locally rather than pulling in a dependency for one call. */
type TurnstileWindow = {
  turnstile?: {reset: (container?: string | HTMLElement) => void};
};

/** React 18's DOM allow-list (and @types/react@18) has no `inert` prop — it arrived in React 19 —
 * so it is spread in as a plain string attribute, which is how the HTML spec spells it anyway. */
const INERT = {inert: ''} as Record<string, string>;

/** Validation keys that have their own inline <span> under an input. */
const RENDERED_FIELDS = ['name', 'email', 'orderNumber', 'message'];

export default function Contact() {
  const {siteKey, enabled} = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nonce = useNonce();
  const submitting = useNavigation().state !== 'idle';
  const result = data?.result;
  const values = data?.values ?? {
    name: '',
    email: '',
    orderNumber: '',
    message: '',
  };
  const fieldError = (f: string) =>
    result?.kind === 'validation' ? result.fields[f] : undefined;
  // Ops derives `fields` from zod paths, so it can name a key the form doesn't render
  // (e.g. `turnstileToken` when the widget was blocked). Without this those errors would
  // come back as a silent re-render.
  const otherErrors =
    result?.kind === 'validation'
      ? Object.entries(result.fields)
          .filter(([key]) => !RENDERED_FIELDS.includes(key))
          .map(([, message]) => message)
      : [];

  // Turnstile tokens are single-use: <Form> re-renders the same widget after a failed
  // submit, so without a reset the redeemed token is resubmitted and every retry fails.
  // Every result that keeps the form mounted is reset — 'unavailable' included, since ops
  // redeemed (or never saw) the token either way and the visitor is about to retry.
  useEffect(() => {
    if (
      result &&
      (result.kind === 'validation' ||
        result.kind === 'turnstile' ||
        result.kind === 'capped' ||
        result.kind === 'unavailable')
    ) {
      (window as unknown as TurnstileWindow).turnstile?.reset();
    }
  }, [data, result]);

  // Only a DISABLED form (no keys configured) replaces the page: there is nothing to submit and
  // nothing typed to lose. A runtime 'unavailable' (ops down, timeout, 503) is a retryable
  // failure of an already-typed message, so it renders as a banner over the still-mounted form
  // with the values restored — replacing the page there threw the customer's message away.
  if (!enabled) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="font-display text-3xl text-ink">Contact us</h1>
        <p className="mt-4 text-ink">
          The contact form is temporarily unavailable — please try again later.
        </p>
      </main>
    );
  }
  if (result?.kind === 'sent') {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="font-display text-3xl text-ink">Sent!</h1>
        {/* Deliberately does NOT name the support address — the whole point of this
            form is that the address is never printed on a public page (spec §1). */}
        <p className="mt-4 text-ink">
          A confirmation from Doge Buddy Support is on its way — reply to it to
          add anything (photos included).
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <script src={TURNSTILE_SCRIPT} async defer nonce={nonce} />
      <h1 className="font-display text-3xl text-ink">Contact us</h1>
      {result?.kind === 'turnstile' && (
        <p role="alert" className="mt-4 text-red-700">
          Verification failed — please try again.
        </p>
      )}
      {result?.kind === 'capped' && (
        <p role="alert" className="mt-4 text-red-700">
          Too many messages right now — please try again later.
        </p>
      )}
      {result?.kind === 'unavailable' && (
        <p role="alert" className="mt-4 text-red-700">
          The contact form is temporarily unavailable — your message is still
          here, please try again in a moment.
        </p>
      )}
      {otherErrors.length > 0 && (
        <p role="alert" className="mt-4 text-red-700">
          {otherErrors.join(' ')}
        </p>
      )}
      <Form method="post" className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-ink">
          Name
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={values.name}
            className="rounded border px-3 py-2"
          />
          {fieldError('name') && (
            <span className="text-sm text-red-700">{fieldError('name')}</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-ink">
          Email
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            defaultValue={values.email}
            className="rounded border px-3 py-2"
          />
          {fieldError('email') && (
            <span className="text-sm text-red-700">{fieldError('email')}</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-ink">
          Order number (optional)
          <input
            name="orderNumber"
            maxLength={20}
            pattern="#?[0-9A-Za-z-]{1,19}"
            title="Your order number, e.g. #1001 — letters, digits and dashes only."
            defaultValue={values.orderNumber}
            placeholder="#1001"
            className="rounded border px-3 py-2"
          />
          {fieldError('orderNumber') && (
            <span className="text-sm text-red-700">
              {fieldError('orderNumber')}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-ink">
          Message
          <textarea
            name="message"
            required
            minLength={10}
            maxLength={4000}
            rows={6}
            defaultValue={values.message}
            className="rounded border px-3 py-2"
          />
          {fieldError('message') && (
            <span className="text-sm text-red-700">
              {fieldError('message')}
            </span>
          )}
        </label>
        {/* Honeypot: off-screen, not display:none (some bots skip hidden fields); humans never see it.
            `inert` (not aria-hidden) because the wrapper holds a FOCUSABLE input: aria-hidden hides
            it from the a11y tree while leaving it reachable, which is exactly the combination
            screen-reader users hit as an unlabelled focus stop. inert removes it from both. */}
        <div
          {...INERT}
          style={{
            position: 'absolute',
            left: '-10000px',
            top: 'auto',
            width: 1,
            height: 1,
            overflow: 'hidden',
          }}
        >
          <label>
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <div className="cf-turnstile" data-sitekey={siteKey} />
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-ink px-4 py-2 text-surface"
        >
          {submitting ? 'Sending…' : 'Send message'}
        </button>
      </Form>
    </main>
  );
}
