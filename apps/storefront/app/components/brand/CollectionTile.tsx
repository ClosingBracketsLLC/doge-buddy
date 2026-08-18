import {Link} from 'react-router';
import mascot from '~/assets/mascot.svg';
import tileToys from '~/assets/art/tile-toys.webp';
import tileWalks from '~/assets/art/tile-walks.webp';
import tileBeds from '~/assets/art/tile-beds.webp';
import tileGrooming from '~/assets/art/tile-grooming.webp';

const TILE_ART: Record<string, string> = {
  'toys-play': tileToys,
  'walks-travel': tileWalks,
  'beds-comfort': tileBeds,
  'grooming-care': tileGrooming,
};

export function CollectionTile({
  handle,
  title,
}: {
  handle: string;
  title: string;
}) {
  const art = TILE_ART[handle];

  return (
    <Link
      to={`/collections/${handle}`}
      prefetch="intent"
      className="block overflow-hidden rounded-2xl border-2 border-ink bg-badge transition-transform hover:-translate-y-1 hover:shadow-[4px_4px_0_var(--color-ink)] motion-reduce:transition-none"
    >
      {art ? (
        <img src={art} alt="" aria-hidden className="aspect-square w-full object-cover" />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center bg-surface-raised">
          <img src={mascot} alt="" aria-hidden className="h-32 w-32" />
        </div>
      )}
      <h3 className="border-t-2 border-ink bg-badge px-4 py-3 text-center font-display text-xl text-ink">
        {title}
      </h3>
    </Link>
  );
}
