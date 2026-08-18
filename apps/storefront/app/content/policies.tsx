// Repo-authored policy copy, replacing the skeleton's Storefront-API-driven
// policy routes (see policies._index.tsx / policies.$handle.tsx). Versioned
// and PR-reviewable; pasted into Shopify Settings → Policies at launch
// (Phase 7 checklist item) so hosted-checkout footer links match.

export type PolicyHandle = 'shipping' | 'returns' | 'privacy' | 'terms';

export interface Policy {
  handle: PolicyHandle;
  title: string;
  updated: string;
  Body: () => React.JSX.Element;
}

function ShippingBody() {
  return (
    <>
      <p>
        All orders ship from US warehouses. Standard delivery arrives in 3–7
        business days after your order is processed (processing up to 1 business
        day). Tracking is emailed as soon as your order ships, and also appears
        in your account&apos;s order history.
      </p>
      <p>We currently ship within the United States only.</p>
      <p>
        If your order hasn&apos;t arrived within the promised window, contact us
        and we&apos;ll make it right — replacement or full refund.
      </p>
    </>
  );
}

function ReturnsBody() {
  return (
    <>
      <h2 className="font-display font-bold">30-day returns</h2>
      <p>
        If you or your dog aren&apos;t happy with an item, contact us within 30
        days of delivery for a prepaid return label — refunds go to the original
        payment method within 5–10 business days of the returned item arriving.
      </p>
      <p>
        Items should be unused where possible, but if your dog took a test chew,
        talk to us anyway.
      </p>
      <h2 className="font-display font-bold">Damaged or wrong items</h2>
      <p>
        Full refund or replacement, photos appreciated, no return needed for
        damaged goods.
      </p>
    </>
  );
}

function PrivacyBody() {
  return (
    <>
      <p>
        We collect what a store needs to work — your order details, shipping
        address, and email. Payment is processed by Shopify; we never see your
        card number.
      </p>
      <h2 className="font-display font-bold">Who we share data with</h2>
      <p>
        To run the store we share data with service providers acting on our
        behalf:
      </p>
      <ul className="list-disc pl-6">
        <li>Shopify (storefront and payments)</li>
        <li>
          CJ Dropshipping (order fulfillment and shipping — they receive your
          name and shipping address)
        </li>
        <li>Google Workspace (support email)</li>
        <li>
          Anthropic (AI assistance for product curation and support drafting;
          support messages may be processed to draft replies)
        </li>
      </ul>
      <p>We don&apos;t sell your data.</p>
      <p>
        Email support@ (email address coming soon — see contact page) to access
        or delete your data.
      </p>
    </>
  );
}

function TermsBody() {
  return (
    <>
      <p>Standard short-form terms:</p>
      <ul className="list-disc pl-6">
        <li>US customers only.</li>
        <li>Prices in USD.</li>
        <li>We may cancel and fully refund orders we can&apos;t fulfill.</li>
        <li>
          Disputes are governed by the laws of the state of the LLC&apos;s
          registration.
        </li>
        <li>The policies above are part of these terms.</li>
      </ul>
    </>
  );
}

export const POLICIES: Policy[] = [
  {
    handle: 'shipping',
    title: 'Shipping',
    updated: '2026-08-17',
    Body: ShippingBody,
  },
  {
    handle: 'returns',
    title: 'Returns',
    updated: '2026-08-17',
    Body: ReturnsBody,
  },
  {
    handle: 'privacy',
    title: 'Privacy',
    updated: '2026-08-17',
    Body: PrivacyBody,
  },
  {
    handle: 'terms',
    title: 'Terms',
    updated: '2026-08-17',
    Body: TermsBody,
  },
];
