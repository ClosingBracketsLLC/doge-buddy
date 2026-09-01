import {useEffect} from 'react';
import {render, screen, fireEvent} from '@testing-library/react';
import {CATEGORIES} from '@doge-buddy/core';
import {Aside, useAside} from '../Aside';
import {CartEmpty} from '../CartMain';

// Opens the cart aside on mount so the dialog starts in its "expanded"
// state, mirroring how PageLayout's header cart button opens it in the app.
function OpenCartAside() {
  const {open} = useAside();
  useEffect(() => {
    open('cart');
  }, [open]);
  return null;
}

function renderCartAsideEmpty() {
  return render(
    <Aside.Provider>
      <OpenCartAside />
      <Aside type="cart" heading="CART">
        <CartEmpty hidden={false} layout="aside" />
      </Aside>
    </Aside.Provider>,
  );
}

it('clicking the empty-cart CTA closes the cart aside', () => {
  renderCartAsideEmpty();

  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveClass('expanded');

  fireEvent.click(screen.getByRole('link', {name: 'Start shopping'}));

  expect(dialog).not.toHaveClass('expanded');
});

it('does not wire a close handler for the page layout (no aside to close)', () => {
  render(
    <Aside.Provider>
      <CartEmpty hidden={false} layout="page" />
    </Aside.Provider>,
  );

  // Should render fine and be clickable without throwing, even though
  // there's no expanded aside for a "page" layout to close.
  fireEvent.click(screen.getByRole('link', {name: 'Start shopping'}));
  expect(screen.getByText('Your cart is empty')).toBeInTheDocument();
});

it('points the empty-cart CTA at the first real category, not a hardcoded handle', () => {
  render(
    <Aside.Provider>
      <CartEmpty hidden={false} layout="page" />
    </Aside.Provider>,
  );

  // Derived from CATEGORIES (the same source Header and Hero use) so the CTA cannot outlive a
  // renamed or reordered category and 404 the way the hardcoded `/collections/toys-play` would.
  expect(screen.getByRole('link', {name: 'Start shopping'})).toHaveAttribute(
    'href',
    `/collections/${CATEGORIES[0].handle}`,
  );
});
