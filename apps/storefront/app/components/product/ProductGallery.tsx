import {useState} from 'react';
import {Image} from '@shopify/hydrogen';
import {ProductImage} from '~/components/ProductImage';

export interface GalleryImage {
  __typename: 'Image';
  id?: string | null;
  url: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface GalleryMediaNode {
  id: string;
  image?: GalleryImage | null;
}

/**
 * Main product image + thumbnail row (product-page-v2 spec Decision 9). Main image precedence:
 * explicitly clicked thumb → selected variant's image → first media image → mascot placeholder
 * (ProductImage's own fallback). A variant change snaps back to the variant's image: the click
 * is remembered WITH the variant it was made under and derived-invalid during render — an
 * effect-based reset would run post-paint and flash one stale frame. One thumb per unique image
 * URL (variants often share one supplier image; a variant-attached image also appears in product
 * media). One image = no thumb row (today's rendering).
 */
export function ProductGallery({
  media,
  variantImage,
}: {
  media: GalleryMediaNode[];
  variantImage: GalleryImage | null | undefined;
}) {
  const [selection, setSelection] = useState<{
    mediaId: string;
    forVariant: string | null;
  } | null>(null);
  const variantImageId = variantImage?.id ?? null;

  const seenUrls = new Set<string>();
  const images = media.filter(
    (node): node is GalleryMediaNode & {image: GalleryImage} => {
      if (!node.image) return false;
      if (seenUrls.has(node.image.url)) return false;
      seenUrls.add(node.image.url);
      return true;
    },
  );
  const active =
    selection && selection.forVariant === variantImageId
      ? images.find((node) => node.id === selection.mediaId)
      : undefined;
  const mainImage = active?.image ?? variantImage ?? images[0]?.image ?? null;

  return (
    <div>
      <ProductImage image={mainImage} />
      {images.length > 1 ? (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {images.map((node, index) => {
            const isCurrent =
              mainImage != null &&
              (node.image.id === mainImage.id ||
                node.image.url === mainImage.url);
            return (
              <button
                key={node.id}
                type="button"
                aria-label={`Show image ${index + 1}`}
                aria-current={isCurrent}
                onClick={() =>
                  setSelection({mediaId: node.id, forVariant: variantImageId})
                }
                className={`h-20 w-20 shrink-0 overflow-hidden rounded-xl border-2 bg-surface-raised ${
                  isCurrent ? 'border-ink' : 'border-ink/20'
                }`}
              >
                <Image
                  alt={node.image.altText || 'Product image thumbnail'}
                  aspectRatio="1/1"
                  data={node.image}
                  loading="lazy"
                  sizes="80px"
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
