import { cn } from "@/lib/utils";

type BrandMarkProps = {
  className?: string;
  invert?: boolean;
};

export function BrandMark({ className, invert = false }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "brand-mark inline-flex size-8 items-center justify-center rounded-full",
        invert ? "bg-paper text-ink" : "bg-violet text-paper",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-4 fill-current">
        <path d="M8.2 5.9a1 1 0 0 1 1.54-.84l8.1 6.1a1.05 1.05 0 0 1 0 1.68l-8.1 6.1a1 1 0 0 1-1.54-.84V5.9Z" />
      </svg>
    </span>
  );
}
