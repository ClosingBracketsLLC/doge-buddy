import {fireEvent, render, screen} from '@testing-library/react';
import {vi} from 'vitest';

// ProductForm calls useNavigate() unconditionally (ProductForm.tsx:18); the GLOBAL setup mocks
// only react-router's Link, so without this file-local mock every render throws "useNavigate()
// may be used only in the context of a <Router>". A file-local vi.mock REPLACES the global one,
// so the Link stub must be re-declared here (contact.test.tsx shows the house pattern).
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: {to: string; children?: React.ReactNode}) => <a href={props.to}>{props.children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('~/components/Aside', () => ({
  useAside: () => ({open: vi.fn()}),
}));

const captured: {lines?: Array<{quantity: number}>} = {};
vi.mock('~/components/AddToCartButton', () => ({
  AddToCartButton: ({lines, children}: {lines: Array<{quantity: number}>; children: React.ReactNode}) => {
    captured.lines = lines;
    return <button type="button">{children}</button>;
  },
}));

import {ProductForm} from '../ProductForm';

const selectedVariant = {
  id: 'gid://shopify/ProductVariant/1',
  availableForSale: true,
  title: 'Default Title',
  price: {amount: '19.99', currencyCode: 'USD'},
  selectedOptions: [],
} as any;

it('defaults to quantity 1 and passes it into the cart line', () => {
  render(<ProductForm productOptions={[]} selectedVariant={selectedVariant} />);
  expect(captured.lines?.[0]?.quantity).toBe(1);
});

it('increments/decrements within 1..99 and the line follows', () => {
  render(<ProductForm productOptions={[]} selectedVariant={selectedVariant} />);
  fireEvent.click(screen.getByRole('button', {name: 'Increase quantity'}));
  fireEvent.click(screen.getByRole('button', {name: 'Increase quantity'}));
  expect(screen.getByText('3')).toBeInTheDocument();
  expect(captured.lines?.[0]?.quantity).toBe(3);
  fireEvent.click(screen.getByRole('button', {name: 'Decrease quantity'}));
  expect(captured.lines?.[0]?.quantity).toBe(2);
});

it('cannot go below 1', () => {
  render(<ProductForm productOptions={[]} selectedVariant={selectedVariant} />);
  expect(screen.getByRole('button', {name: 'Decrease quantity'})).toBeDisabled();
});
