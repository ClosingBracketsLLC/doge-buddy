import {fireEvent, render, screen} from '@testing-library/react';
import {ProductGallery} from '../ProductGallery';

const img = (n: number) => ({
  __typename: 'Image' as const,
  id: `img-${n}`,
  url: `https://cdn.example.com/${n}.jpg`,
  altText: `Image ${n}`,
  width: 800,
  height: 800,
});
const media = (n: number) => ({id: `media-${n}`, image: img(n)});

it("renders the mascot placeholder with no media and no variant image (today's page)", () => {
  render(<ProductGallery media={[]} variantImage={null} />);
  expect(
    screen.getByRole('img', {name: /doge buddy mascot/i}),
  ).toBeInTheDocument();
});

it('renders no thumbnail row for a single image', () => {
  render(<ProductGallery media={[media(1)]} variantImage={null} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('clicking a thumb swaps the main image', () => {
  render(<ProductGallery media={[media(1), media(2)]} variantImage={img(1)} />);
  fireEvent.click(screen.getByRole('button', {name: /show image 2/i}));
  const main = screen.getAllByRole('img')[0]!;
  expect(main.getAttribute('srcset')).toContain('2.jpg');
});

it('variant image wins by default; a variant CHANGE resets an explicit thumb choice', () => {
  const {rerender} = render(
    <ProductGallery
      media={[media(1), media(2), media(3)]}
      variantImage={img(1)}
    />,
  );
  fireEvent.click(screen.getByRole('button', {name: /show image 3/i}));
  expect(screen.getAllByRole('img')[0]!.getAttribute('srcset')).toContain(
    '3.jpg',
  );
  rerender(
    <ProductGallery
      media={[media(1), media(2), media(3)]}
      variantImage={img(2)}
    />,
  );
  expect(screen.getAllByRole('img')[0]!.getAttribute('srcset')).toContain(
    '2.jpg',
  );
});

it('falls back to the first media image when the variant has none', () => {
  render(<ProductGallery media={[media(1), media(2)]} variantImage={null} />);
  expect(screen.getAllByRole('img')[0]!.getAttribute('srcset')).toContain(
    '1.jpg',
  );
});

it('renders one thumb per unique image URL (shared variant images dedupe)', () => {
  const dup = {id: 'media-9', image: img(1)}; // same URL as media(1)
  render(
    <ProductGallery media={[media(1), dup, media(2)]} variantImage={null} />,
  );
  expect(screen.getAllByRole('button')).toHaveLength(2);
});
