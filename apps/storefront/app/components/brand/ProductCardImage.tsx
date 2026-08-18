import mascot from '~/assets/mascot.svg';

export function ProductCardImage({
  image,
  title,
}: {
  image?: {url: string; altText?: string | null} | null;
  title: string;
}) {
  if (!image) {
    return (
      <div className="bg-accent/20 rounded-2xl overflow-hidden flex items-center justify-center">
        <img src={mascot} alt="Doge Buddy mascot placeholder" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl overflow-hidden">
      <img src={image.url} alt={image.altText ?? title} />
    </div>
  );
}
