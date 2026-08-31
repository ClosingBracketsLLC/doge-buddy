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
  if (!opsBaseUrl)
    return {result: {kind: 'unavailable'} as ContactResult, values: null};
  const parsed = parseContactForm(await request.formData());
  const result = await forwardContact({
    opsBaseUrl,
    ...parsed,
    ip: clientIp(request.headers),
  });
  return {result, values: result.kind === 'sent' ? null : parsed.fields};
}

const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js';

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

  if (!enabled || result?.kind === 'unavailable') {
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
        {/* Honeypot: off-screen, not display:none (some bots skip hidden fields); humans never see it. */}
        <div
          aria-hidden="true"
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
