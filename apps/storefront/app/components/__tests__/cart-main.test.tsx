import {useEffect} from 'react';
import {render, screen, fireEvent} from '@testing-library/react';
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
