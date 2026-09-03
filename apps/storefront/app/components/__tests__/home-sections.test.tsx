import {render, screen} from '@testing-library/react';
import {createRoutesStub} from 'react-router';
import {ValueProps} from '../brand/ValueProps';
import {CategoryTiles} from '../brand/CategoryTiles';

// router wrapper idiom as in Task 2 (CollectionTile and the policy link render <Link>)
function renderWithRouter(ui: React.ReactElement) {
  const Stub = createRoutesStub([{path: '/', Component: () => ui}]);
  return render(<Stub initialEntries={['/']} />);
}

describe('ValueProps', () => {
  it('renders the three value props with the returns-policy link', () => {
    renderWithRouter(<ValueProps />);
    expect(screen.getByText('Ships from US warehouses')).toBeInTheDocument();
    expect(screen.getByText('3–7 day delivery')).toBeInTheDocument();
    expect(screen.getByRole('link', {name: /returns policy/i})).toHaveAttribute(
      'href',
      '/policies/returns',
    );
  });
});

describe('CategoryTiles', () => {
  it('renders one tile per category, linking its collection', () => {
    renderWithRouter(<CategoryTiles />);
    expect(screen.getByText('Shop by category')).toBeInTheDocument();
    for (const [handle, title] of [
      ['toys-play', 'Toys & Play'],
      ['walks-travel', 'Walks & Travel'],
      ['beds-comfort', 'Beds & Comfort'],
      ['grooming-care', 'Grooming & Care'],
    ]) {
      expect(screen.getByRole('link', {name: new RegExp(title!)})).toHaveAttribute(
        'href',
        `/collections/${handle}`,
      );
    }
  });
});
