/**
 * Banner-ribbon section heading — the signature element of the retro badge
 * system: a cerulean pennant bar with V-notched ends, set in the display
 * face. Single element + clip-path keeps it robust (no pseudo z-fights).
 */
export function RibbonHeading({children}: {children: React.ReactNode}) {
  return (
    <div className="my-10 flex items-center justify-center">
      <h2 className="bg-info px-12 py-2.5 text-center font-display text-2xl text-surface-raised [clip-path:polygon(0_0,100%_0,calc(100%_-_20px)_50%,100%_100%,0_100%,20px_50%)] md:text-3xl">
        {children}
      </h2>
    </div>
  );
}
