import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/policies.$handle';
import {POLICIES} from '~/content/policies';

export const meta: Route.MetaFunction = ({data}) => {
  return [{title: `${data?.policy.title ?? ''} — Doge Buddy`}];
};

export async function loader({params}: Route.LoaderArgs) {
  const policy = POLICIES.find((item) => item.handle === params.handle);

  if (!policy) {
    throw new Response('Not Found', {status: 404});
  }

  return {policy};
}

export default function Policy() {
  const {policy} = useLoaderData<typeof loader>();
  const {Body} = policy;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:py-12">
      <Link
        to="/policies"
        className="text-info underline-offset-4 hover:underline"
      >
        ← Back to Policies
      </Link>
      <h1 className="mt-4 font-display text-4xl text-ink">
        {policy.title}
      </h1>
      <div className="mt-6 flex flex-col gap-4 text-ink">
        <Body />
      </div>
      <p className="mt-8 text-sm text-info">
        Last updated {policy.updated} · This policy will be finalized before
        launch.
      </p>
    </div>
  );
}
