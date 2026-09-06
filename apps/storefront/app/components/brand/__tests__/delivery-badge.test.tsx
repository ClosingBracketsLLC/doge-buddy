import {render, screen} from '@testing-library/react';
import {createRoutesStub} from 'react-router';
import {DeliveryBadge} from '../DeliveryBadge';
import {TrustStrip} from '../TrustStrip';
import {ValueProps} from '../ValueProps';

it.each([
  [null, '3', '7'], ['US', null, '7'], ['US', '3', null], [null, null, null],
])('renders nothing without a full window — never a default promise (%s, %s, %s)', (s, min, max) => {
  const {container} = render(<DeliveryBadge shipsFrom={s} minDays={min} maxDays={max} />);
  expect(container).toBeEmptyDOMElement();
});

it("renders the product's own window and names the origin honestly", () => {
  render(<DeliveryBadge shipsFrom="CN" minDays="7" maxDays="14" />);
  expect(screen.getByText(/7–14 days/)).toBeInTheDocument();
  expect(screen.getByText(/partner warehouse/i)).toBeInTheDocument();
});

it('US products say US warehouse', () => {
  render(<DeliveryBadge shipsFrom="US" minDays="3" maxDays="7" />);
  expect(screen.getByText(/US warehouse/)).toBeInTheDocument();
  expect(screen.getByText(/3–7 days/)).toBeInTheDocument();
});

it('no component hard-codes a site-wide delivery promise', () => {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: () => (
        <>
          <TrustStrip />
          <ValueProps />
        </>
      ),
    },
  ]);
  render(<Stub initialEntries={['/']} />);
  expect(screen.queryByText(/3–7 day delivery/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Ships from US warehouses/)).not.toBeInTheDocument();
});
