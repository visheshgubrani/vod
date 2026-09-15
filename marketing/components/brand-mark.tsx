import { cn } from "@/lib/utils";

type BrandMarkProps = {
  className?: string;
  /** Renders the mark for a charcoal surface. */
  invert?: boolean;
};

/**
 * The ClipMux mark: a play glyph cut into a rounded square. One shape, two
 * colours — burnt orange on light surfaces, ember on dark ones.
 */
export function BrandMark({ className, invert = false }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-[9px]",
        invert ? "bg-ember text-[#171715]" : "bg-brand text-white",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-4 fill-current">
        <path d="M9.1 5.6a1 1 0 0 1 1.53-.85l7.2 5.4a1.05 1.05 0 0 1 0 1.7l-7.2 5.4a1 1 0 0 1-1.53-.85V5.6Z" />
      </svg>
    </span>
  );
}
