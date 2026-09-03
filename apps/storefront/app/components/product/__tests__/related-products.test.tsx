import {render, screen} from '@testing-library/react';
import {createRoutesStub} from 'react-router';
import {RelatedProducts} from '../RelatedProducts';

// ProductItem calls useVariantUrl(), which reads useLocation() — a real (unmocked) react-router
// hook that needs a Router in the tree. The global setup (app/test/setup.tsx) only stubs `Link`,
// so we still need a router; no existing __tests__ file renders anything link-bearing that also
// needs useLocation, so per the brief's fallback we use createRoutesStub (react-router's own
// testing helper) rather than inventing a new idiom.
function renderWithRouter(ui: React.ReactElement) {
  const Stub = createRoutesStub([{path: '/', Component: () => ui}]);
  return render(<Stub initialEntries={['/']} />);
}

const product = (id: string, title: string) => ({
  id,
  title,
  handle: title.toLowerCase(),
  priceRange: {minVariantPrice: {amount: '19.99', currencyCode: 'USD'}},
  featuredImage: null,
});

describe('RelatedProducts', () => {
  it('renders nothing for null', () => {
    expect(
      renderWithRouter(<RelatedProducts products={null} />).container,
    ).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty list (no heading over an empty grid)', () => {
    expect(
      renderWithRouter(<RelatedProducts products={[]} />).container,
    ).toBeEmptyDOMElement();
  });

  it('renders the heading and one card per product', () => {
    renderWithRouter(
      <RelatedProducts
        products={[product('1', 'Rope'), product('2', 'Ball')] as never}
      />,
    );
    expect(screen.getByText('You might also like')).toBeInTheDocument();
    expect(screen.getByText('Rope')).toBeInTheDocument();
    expect(screen.getByText('Ball')).toBeInTheDocument();
  });
});
