import {render, screen} from '@testing-library/react';
import {ProductHighlights} from '../ProductHighlights';
import {ProductSpecs, formatVariantWeight} from '../ProductSpecs';
import {WhatsInBox} from '../WhatsInBox';

describe('ProductHighlights', () => {
  it('renders nothing without data', () => {
    expect(render(<ProductHighlights highlights={null} />).container).toBeEmptyDOMElement();
  });
  it('renders one bullet per highlight', () => {
    render(<ProductHighlights highlights={['Durable rope core', 'Machine washable', 'Non-slip grip']} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Machine washable')).toBeInTheDocument();
  });
});

describe('ProductSpecs', () => {
  const specs = [{label: 'Material', value: 'Cotton'}];
  it('renders nothing without data', () => {
    expect(render(<ProductSpecs specs={null} />).container).toBeEmptyDOMElement();
  });
  it('renders the rows', () => {
    render(<ProductSpecs specs={specs} />);
    expect(screen.getByText('Material')).toBeInTheDocument();
    expect(screen.getByText('Cotton')).toBeInTheDocument();
  });
  it('appends a live Weight row and drops an agent-written Weight duplicate', () => {
    render(
      <ProductSpecs
        specs={[...specs, {label: 'Weight', value: 'about 1 pound'}]}
        variantWeight={250}
        variantWeightUnit="GRAMS"
      />,
    );
    expect(screen.getByText('250 g')).toBeInTheDocument();
    expect(screen.queryByText('about 1 pound')).not.toBeInTheDocument();
  });
  it('keeps the agent Weight row when the variant carries no weight (spec B2 fallback)', () => {
    render(<ProductSpecs specs={[...specs, {label: 'Weight', value: 'about 1 pound'}]} />);
    expect(screen.getByText('about 1 pound')).toBeInTheDocument();
  });
});

describe('formatVariantWeight', () => {
  it.each([
    [250, 'GRAMS', '250 g'],
    [1.5, 'KILOGRAMS', '1.5 kg'],
    [8, 'OUNCES', '8 oz'],
    [2, 'POUNDS', '2 lb'],
    [0, 'GRAMS', null],
    [null, 'GRAMS', null],
    [250, 'FURLONGS', null],
  ])('(%s, %s) -> %s', (weight, unit, expected) => {
    expect(formatVariantWeight(weight, unit)).toBe(expected);
  });
});

describe('WhatsInBox', () => {
  it('renders nothing without data', () => {
    expect(render(<WhatsInBox text={null} />).container).toBeEmptyDOMElement();
  });
  it('renders the line under its heading', () => {
    render(<WhatsInBox text="1x rope toy" />);
    expect(screen.getByRole('heading', {name: "What's in the box"})).toBeInTheDocument();
    expect(screen.getByText('1x rope toy')).toBeInTheDocument();
  });
});
