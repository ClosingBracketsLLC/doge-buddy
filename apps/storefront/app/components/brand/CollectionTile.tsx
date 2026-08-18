import {Link} from 'react-router';
import mascot from '~/assets/mascot.svg';

const TILE_TREATMENTS: Record<string, string> = {
  'toys-play': 'bg-accent/30',
  'walks-travel': 'bg-info/15',
  'beds-comfort': 'bg-badge',
  'grooming-care': 'bg-cta/10',
};

export function CollectionTile({
  handle,
  title,
}: {
  handle: string;
  title: string;
}) {
  const treatment = TILE_TREATMENTS[handle] ?? 'bg-surface-raised';

  return (
    <Link
      to={`/collections/${handle}`}
      prefetch="intent"
      className={`${treatment} rounded-2xl p-6 hover:shadow-md flex items-center gap-4`}
    >
      <img src={mascot} alt="" aria-hidden className="w-10 h-10 shrink-0" />
      <h3 className="font-display font-bold text-xl text-ink">{title}</h3>
    </Link>
  );
}
