import {render, screen} from '@testing-library/react';
import {TrustStrip} from '../TrustStrip';
import {EmptyState} from '../EmptyState';
import {ProductCardImage} from '../ProductCardImage';

it('trust strip carries the exact promise copy', () => {
  render(<TrustStrip />);
  expect(screen.getByText('Ships from US warehouses · 3–7 day delivery')).toBeInTheDocument();
});

it('empty state shows title, message, optional CTA', () => {
  render(<EmptyState title="Nothing here" message="Try a search." cta={{to: '/collections/toys-play', label: 'Shop toys'}} />);
  expect(screen.getByText('Nothing here')).toBeInTheDocument();
  expect(screen.getByRole('link', {name: 'Shop toys'})).toHaveAttribute('href', '/collections/toys-play');
});

it('product card falls back to mascot art when no image', () => {
  render(<ProductCardImage image={null} title="Sample — Rope Toy" />);
  expect(screen.getByRole('img', {name: /doge buddy mascot/i})).toBeInTheDocument();
});

it('product card uses the product image when present', () => {
  render(<ProductCardImage image={{url: 'https://cdn.shopify.com/x.jpg', altText: 'Rope toy'}} title="Sample — Rope Toy" />);
  expect(screen.getByRole('img', {name: 'Rope toy'})).toBeInTheDocument();
});
