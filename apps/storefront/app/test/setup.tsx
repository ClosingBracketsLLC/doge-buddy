import '@testing-library/jest-dom/vitest';
import {vi} from 'vitest';

// react-router's <Link> reads NavigationContext, which is only populated
// inside a Router. Brand components render outside any router in these
// tests, so we replace `react-router`'s Link with a plain anchor for the
// whole suite. This is the single, consistent mechanism this app uses for
// giving Link-rendering components a home in tests (see task-3 brief).
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...rest
    }: {
      to: string;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  };
});
