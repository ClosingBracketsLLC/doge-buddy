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
          "All orders ship from US warehouses. Standard delivery arrives in 3–7 business days after your order is processed (processing up to 1 business day). Tracking is emailed as soon as your order ships, and also appears in your account's order history.",
          'We currently ship within the United States only.',
          "If your order hasn't arrived within the promised window, contact us with your order number and we'll reship it at no charge. If we can't reship it, we'll refund it.",
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
        ],
      },
      {
        heading: 'Damaged, defective, or wrong items',
        paragraphs: [
          "Contact us within 14 days of delivery with a photo of what arrived. We'll send a replacement at no charge — no return needed. If we can't replace it, we'll refund it.",
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
          'Email support@ (email address coming soon — see contact page) to access or delete your data.',
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
