import {render, screen} from '@testing-library/react';
import {POLICY_COPY} from '@doge-buddy/core';
import {TrustBadges} from '../TrustBadges';
import {ShippingReturnsAccordion} from '../ShippingReturnsAccordion';

describe('TrustBadges', () => {
  it('renders the four badges (Decision 11)', () => {
    render(<TrustBadges />);
    expect(screen.getByText('US warehouses')).toBeInTheDocument();
    expect(screen.getByText('3–7 day delivery')).toBeInTheDocument();
    expect(screen.getByText('Secure checkout by Shopify')).toBeInTheDocument();
    expect(screen.getByText(/All sales final/)).toBeInTheDocument();
  });
  it('links the honesty badge to the real returns policy route', () => {
    render(<TrustBadges />);
    expect(screen.getByRole('link', {name: /policy/i})).toHaveAttribute('href', '/policies/returns');
  });
});

describe('ShippingReturnsAccordion', () => {
  it('builds both summaries from POLICY_COPY verbatim (no new copy authored)', () => {
    render(<ShippingReturnsAccordion shipsFrom="US warehouse" minDays="3" maxDays="7" />);
    const shippingLead = POLICY_COPY.find((p) => p.handle === 'shipping')!.sections[0]!.paragraphs[0]!;
    const returnsLead = POLICY_COPY.find((p) => p.handle === 'returns')!.sections[0]!.paragraphs[0]!;
    expect(screen.getByText(shippingLead)).toBeInTheDocument();
    expect(screen.getByText(returnsLead)).toBeInTheDocument();
    expect(screen.getByText('Ships from US warehouse · 3–7 days')).toBeInTheDocument();
  });
  it('links both full policy pages', () => {
    render(<ShippingReturnsAccordion />);
    expect(screen.getByRole('link', {name: /shipping policy/i})).toHaveAttribute('href', '/policies/shipping');
    expect(screen.getByRole('link', {name: /returns policy/i})).toHaveAttribute('href', '/policies/returns');
  });
  it('omits the delivery line when metafields are absent, but still renders', () => {
    render(<ShippingReturnsAccordion />);
    expect(screen.queryByText(/Ships from/)).not.toBeInTheDocument();
    expect(screen.getByText('Shipping')).toBeInTheDocument();
  });
});
