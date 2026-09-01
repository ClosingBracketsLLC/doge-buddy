import {Link} from 'react-router';
import {CATEGORIES} from '@doge-buddy/core';
import heroArt from '~/assets/art/hero-mascot.webp';

export function Hero() {
  return (
    <section className="overflow-hidden rounded-2xl border-4 border-ink bg-surface-raised shadow-sm md:flex md:items-stretch">
      <div className="flex flex-col justify-center px-6 py-10 md:w-1/2 md:px-10">
        <h1 className="font-display text-5xl leading-tight text-ink md:text-6xl">
          Great gear for your best friend
        </h1>
        <p className="mt-4 text-lg text-info">
          Toys, walks, beds, and grooming — picked for happy dogs, shipped
          fast from US warehouses.
        </p>
        <div>
          <Link
            to={`/collections/${CATEGORIES[0].handle}`}
            className="mt-6 inline-block rounded-2xl border-2 border-ink bg-cta px-8 py-3 font-display text-xl text-white shadow-[4px_4px_0_var(--color-ink)] transition-transform hover:-translate-y-0.5 motion-reduce:transition-none"
          >
            Shop toys
          </Link>
        </div>
      </div>
      <div className="border-t-4 border-ink md:w-1/2 md:border-l-4 md:border-t-0">
        <img
          src={heroArt}
          alt=""
          aria-hidden
          className="h-full w-full object-cover"
        />
      </div>
    </section>
  );
}
