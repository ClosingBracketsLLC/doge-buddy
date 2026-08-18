import type {ProductVariantFragment} from 'storefrontapi.generated';
import {Image} from '@shopify/hydrogen';
import mascot from '~/assets/mascot.svg';

export function ProductImage({
  image,
}: {
  image: ProductVariantFragment['image'];
}) {
  if (!image) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-2xl border-2 border-ink bg-accent/20">
        <img
          src={mascot}
          alt="Doge Buddy mascot placeholder"
          className="h-40 w-40"
        />
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border-2 border-ink bg-surface-raised">
      <Image
        alt={image.altText || 'Product Image'}
        aspectRatio="1/1"
        data={image}
        key={image.id}
        loading="eager"
        sizes="(min-width: 45em) 50vw, 100vw"
      />
    </div>
  );
}
