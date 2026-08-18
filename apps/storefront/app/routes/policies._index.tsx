import {Link} from 'react-router';
import type {Route} from './+types/policies._index';
import {POLICIES} from '~/content/policies';

export const meta: Route.MetaFunction = () => {
  return [{title: 'Policies — Doge Buddy'}];
};

export default function Policies() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:py-12">
      <h1 className="font-display text-4xl text-ink">Policies</h1>
      <ul className="mt-6 flex flex-col gap-3">
        {POLICIES.map((policy) => (
          <li key={policy.handle}>
            <Link
              to={`/policies/${policy.handle}`}
              className="text-info underline-offset-4 hover:underline"
            >
              {policy.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
