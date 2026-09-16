/**
 * The ClipMux brand glyph — an orange tile carrying a white play triangle.
 *
 * This is the same mark the marketing site serves as `app/icon.svg`, inlined
 * here so the docs site does not reach across package boundaries for an asset.
 * It renders at whatever size the surrounding text sets, so callers only need
 * to place it and let it inherit.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 64 64"
      width="1.25rem"
      height="1.25rem"
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="var(--brand)" />
      <path
        d="M25 18.6a3 3 0 0 1 4.59-2.54l19.6 14.9a3.1 3.1 0 0 1 0 5.08l-19.6 14.9A3 3 0 0 1 25 48.4V18.6Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}
