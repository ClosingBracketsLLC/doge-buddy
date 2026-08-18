import {Link} from 'react-router';
import mascot from '~/assets/mascot.svg';

export function EmptyState({
  title,
  message,
  cta,
}: {
  title: string;
  message: string;
  cta?: {to: string; label: string};
}) {
  return (
    <div className="flex flex-col items-center text-center gap-3 py-12">
      <img src={mascot} alt="" aria-hidden className="w-24 h-24" />
      <h2 className="font-display text-xl font-bold text-ink">{title}</h2>
      <p className="text-ink">{message}</p>
      {cta && (
        <Link
          to={cta.to}
          className="bg-cta text-white rounded-2xl px-5 py-2 font-bold"
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
}
