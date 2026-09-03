import {CATEGORIES} from '@doge-buddy/core';
import {CollectionTile} from '~/components/brand/CollectionTile';
import {RibbonHeading} from '~/components/brand/RibbonHeading';

/** Home "Shop by category" grid (spec Decision 4): static — handles/titles compile in from
 *  CATEGORIES and CollectionTile carries its own art, so this needs no query at all. */
export function CategoryTiles() {
  return (
    <section className="mt-12" aria-labelledby="shop-by-category">
      <div id="shop-by-category">
        <RibbonHeading>Shop by category</RibbonHeading>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        {CATEGORIES.map((c) => (
          <CollectionTile key={c.handle} handle={c.handle} title={c.title} />
        ))}
      </div>
    </section>
  );
}
