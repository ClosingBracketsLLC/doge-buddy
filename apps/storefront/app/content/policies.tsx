// Repo-authored policy copy, replacing the skeleton's Storefront-API-driven
// policy routes (see policies._index.tsx / policies.$handle.tsx). Versioned
// and PR-reviewable; pasted into Shopify Settings → Policies at launch
// (Phase 7 checklist item) so hosted-checkout footer links match.
//
// The copy itself is single-sourced in @doge-buddy/core (POLICY_COPY) so the
// support agent can quote the exact same words the storefront renders. This
// file just adds the storefront-only bits (`updated` dates) and renders each
// policy's sections generically: optional heading, then one <p> per
// paragraph.

import {Fragment} from 'react';
import {POLICY_COPY} from '@doge-buddy/core';
import type {PolicyCopy, PolicyHandle as CorePolicyHandle} from '@doge-buddy/core';

export type PolicyHandle = CorePolicyHandle;

export interface Policy {
  handle: PolicyHandle;
  title: string;
  updated: string;
  Body: () => React.JSX.Element;
}

const UPDATED: Record<PolicyHandle, string> = {
  shipping: '2026-08-30',
  returns: '2026-08-30',
  privacy: '2026-08-17',
  terms: '2026-08-17',
};

function makeBody(copy: PolicyCopy) {
  return function Body() {
    return (
      <>
        {copy.sections.map((section) => (
          <Fragment key={section.heading ?? section.paragraphs[0]}>
            {section.heading ? (
              <h2 className="mt-6 font-display text-xl text-ink">
                {section.heading}
              </h2>
            ) : null}
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </Fragment>
        ))}
      </>
    );
  };
}

export const POLICIES: Policy[] = POLICY_COPY.map((copy) => ({
  handle: copy.handle,
  title: copy.title,
  updated: UPDATED[copy.handle],
  Body: makeBody(copy),
}));
