import mascot from '~/assets/mascot.svg';
import {Link} from 'react-router';

export function Hero() {
  return (
    <section className="bg-surface-raised rounded-2xl px-6 py-12 md:flex items-center gap-8 shadow-sm">
      <div className="max-w-xl">
        <h1 className="font-display font-extrabold text-4xl md:text-5xl text-ink">
          Great gear for your best friend
        </h1>
        <p className="mt-4 text-lg text-info">
          Toys, walks, beds, and grooming — picked for happy dogs, shipped fast from US warehouses.
        </p>
        <Link to="/collections/toys-play" className="mt-6 inline-block bg-cta text-white font-bold rounded-2xl px-8 py-3 hover:opacity-90">
          Shop toys
        </Link>
      </div>
      <div className="mt-8 md:mt-0 shrink-0">
        <div className="bg-accent/30 rounded-full p-8">
          <img src={mascot} alt="" aria-hidden className="w-48 h-48 md:w-64 md:h-64" />
        </div>
      </div>
    </section>
  );
}
