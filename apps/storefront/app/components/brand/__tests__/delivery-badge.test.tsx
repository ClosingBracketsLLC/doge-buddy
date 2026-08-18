import {render, screen} from '@testing-library/react';
import {DeliveryBadge} from '../DeliveryBadge';

it.each([
  [null, '3', '7'], ['US warehouse', null, '7'], ['US warehouse', '3', null], [null, null, null],
])('renders nothing when any metafield is missing (%s, %s, %s)', (s, min, max) => {
  const {container} = render(<DeliveryBadge shipsFrom={s} minDays={min} maxDays={max} />);
  expect(container).toBeEmptyDOMElement();
});

it('renders the badge with the exact format when all present', () => {
  render(<DeliveryBadge shipsFrom="US warehouse" minDays="3" maxDays="7" />);
  expect(screen.getByText('Ships from US warehouse · 3–7 days')).toBeInTheDocument();
});
