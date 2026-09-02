export function WhatsInBox({text}: {text: string | null}) {
  if (!text) return null;
  return (
    <div className="mt-8">
      <h2 className="font-display text-2xl text-ink">What's in the box</h2>
      <p className="mt-2 text-ink">{text}</p>
    </div>
  );
}
