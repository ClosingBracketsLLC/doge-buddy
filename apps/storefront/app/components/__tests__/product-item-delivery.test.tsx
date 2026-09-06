import {render, screen} from '@testing-library/react';
import {createRoutesStub} from 'react-router';
import {ProductItem} from '../ProductItem';

const baseProduct = {
  id: 'gid://shopify/Product/1',
  handle: 'rope-toy',
  title: 'Rope Tug Toy',
  featuredImage: null,
  priceRange: {minVariantPrice: {amount: '14.99', currencyCode: 'USD'}},
};

function renderWithRouter(ui: React.ReactElement) {
  const Stub = createRoutesStub([{path: '/', Component: () => ui}]);
  return render(<Stub initialEntries={['/']} />);
}

it('shows the delivery window on the card when the metafields are present', () => {
  renderWithRouter(
    <ProductItem
      product={
        {
          ...baseProduct,
          shipsFrom: {value: 'CN'},
          deliveryMaxDays: {value: '14'},
        } as never
      }
    />,
  );
  expect(screen.getByText(/14 days/)).toBeInTheDocument();
});

it('renders no delivery line when the metafields are absent', () => {
  renderWithRouter(<ProductItem product={baseProduct as never} />);
  expect(screen.queryByText(/days/)).not.toBeInTheDocument();
});
