import {render, screen} from '@testing-library/react';
import {createRoutesStub} from 'react-router';
import {Footer} from '../Footer';

function renderWithRouter(ui: React.ReactElement) {
  const Stub = createRoutesStub([{path: '/', Component: () => ui}]);
  return render(<Stub initialEntries={['/']} />);
}

describe('Footer', () => {
  it('links About to /pages/about alongside the policy links', () => {
    renderWithRouter(<Footer footer={Promise.resolve(null)} header={{} as never} publicStoreDomain="" />);
    expect(screen.getByRole('link', {name: 'About'})).toHaveAttribute('href', '/pages/about');
    expect(screen.getByRole('link', {name: 'Returns'})).toHaveAttribute('href', '/policies/returns');
  });
});
