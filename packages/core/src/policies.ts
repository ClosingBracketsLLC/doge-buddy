// Single-sourced policy copy. The storefront renders this for the /policies
// pages; the support agent quotes it verbatim in its system prompt. Because
// the agent quotes this text directly to customers, wording here must match
// what a customer would see on the storefront exactly — copy fidelity, not
// markup fidelity, is what matters.

export type PolicyHandle = 'shipping' | 'returns' | 'privacy' | 'terms'

export interface PolicySection {
  heading?: string
  paragraphs: string[]
}

export interface PolicyCopy {
  handle: PolicyHandle
  title: string
  sections: PolicySection[]
}

export const POLICY_COPY: PolicyCopy[] = [
  {
    handle: 'shipping',
    title: 'Shipping',
    sections: [
      {
        paragraphs: [
          "Every product page shows that item's own delivery window before you buy — most orders arrive in 7 to 14 days, and some US-warehouse items arrive in 3 to 7. The window is on the product page, in your cart, and in your order confirmation.",
          "Some of our gear ships from our overseas partner warehouse. That's the honest trade: it takes a little longer, and it's why the price is what it is. There are no customs charges or extra fees on delivery — the price you pay at checkout is the price.",
          'Tracking is emailed as soon as your order ships and appears in your account. First tracking scans can take a few days to show up, which is normal.',
          'We ship within the United States only.',
          "If an order runs past its window we'll email you with an updated estimate and you can choose to keep waiting or cancel for a full refund. If it never arrives, we reship at no charge — and refund you if we can't.",
        ],
      },
    ],
  },
  {
    handle: 'returns',
    title: 'Returns',
    sections: [
      {
        heading: 'All sales are final',
        paragraphs: [
          "We don't accept returns or give refunds for change of mind — a product that arrived as described but didn't suit you or your dog is yours to keep. All sales are final.",
          "If something isn't working out, write to us anyway: at our discretion we'll offer a discount code toward a future order.",
          "One exception, and we'll tell you about it rather than wait to be asked: if your order hasn't shipped within the delivery window shown when you bought it, you can cancel it for a full refund. We'll email you first with the new estimate so you can decide.",
        ],
      },
      {
        heading: 'Damaged, defective, or wrong items',
        paragraphs: [
          "Contact us within 14 days of delivery with a photo of what you received, and we'll email you return instructions. Return shipping is at your cost. Once your return reaches us and passes inspection, we'll ship a replacement at no charge. If we can't replace it, we'll refund it.",
          'Refunds, when they apply, go back to the original payment method.',
        ],
      },
    ],
  },
  {
    handle: 'privacy',
    title: 'Privacy',
    sections: [
      {
        paragraphs: [
          'We collect what a store needs to work — your order details, shipping address, and email. Payment is processed by Shopify; we never see your card number.',
        ],
      },
      {
        heading: 'Who we share data with',
        paragraphs: [
          'To run the store we share data with service providers acting on our behalf:',
          'Shopify (storefront and payments)',
          'CJ Dropshipping (order fulfillment and shipping — they receive your name and shipping address)',
          'Google Workspace (support email)',
          'Anthropic (AI assistance for product curation and support drafting; support messages may be processed to draft replies)',
          "We don't sell your data.",
          'Use the contact form at /contact to access or delete your data.',
        ],
      },
    ],
  },
  {
    handle: 'terms',
    title: 'Terms',
    sections: [
      {
        paragraphs: [
          'Standard short-form terms:',
          'US customers only.',
          'Prices in USD.',
          "We may cancel and fully refund orders we can't fulfill.",
          "Disputes are governed by the laws of the state of the LLC's registration.",
          'The policies above are part of these terms.',
        ],
      },
    ],
  },
]

/** All policies flattened to plain text for the agent's system prompt. */
export function policiesAsText(): string {
  return POLICY_COPY.map((policy) => {
    const parts = [`# ${policy.title}`]
    for (const section of policy.sections) {
      if (section.heading) parts.push(`## ${section.heading}`)
      parts.push(...section.paragraphs)
    }
    return parts.join('\n\n')
  }).join('\n\n')
}
