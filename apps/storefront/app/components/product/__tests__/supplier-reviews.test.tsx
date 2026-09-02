import {render, screen} from '@testing-library/react';
import {SupplierReviews} from '../SupplierReviews';

const data = {
  average: 4.6,
  count: 1238,
  reviews: [
    {rating: 5, text: 'Great toy, my dog loves it', date: '2026-06-01', country: 'US'},
    {rating: 4, text: 'Sturdy and washable'},
  ],
  fetchedAt: '2026-09-01T12:00:00.000Z',
};

it('renders nothing without the metafield', () => {
  expect(render(<SupplierReviews data={null} />).container).toBeEmptyDOMElement();
});

it('renders the heading and the FIXED disclosure line verbatim (FTC — Decision 4)', () => {
  render(<SupplierReviews data={data} />);
  expect(screen.getByRole('heading', {name: 'Marketplace reviews'})).toBeInTheDocument();
  // Hardcoded on purpose: this test pins the exact legal disclosure. Do not import it.
  expect(
    screen.getByText(
      "From the supplier's buyers on other marketplaces — not yet from Doge Buddy customers.",
    ),
  ).toBeInTheDocument();
});

it('renders the aggregate line with formatted count and as-of date', () => {
  render(<SupplierReviews data={data} />);
  expect(screen.getByText('★ 4.6 · 1,238 marketplace ratings · as of 2026-09-01')).toBeInTheDocument();
});

it('renders a card per review with stars, text, and date/country when present', () => {
  render(<SupplierReviews data={data} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('Great toy, my dog loves it')).toBeInTheDocument();
  expect(screen.getByText('2026-06-01 · US')).toBeInTheDocument();
  expect(screen.getByLabelText('5 out of 5 stars')).toBeInTheDocument();
});

it('emits NO schema.org markup (Decision 6)', () => {
  const {container} = render(<SupplierReviews data={data} />);
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('[itemtype]')).toBeNull();
});
