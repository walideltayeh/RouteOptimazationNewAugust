import { useId } from "react";

/**
 * The RouteOptima mark: the pin of the logo, drawn as an app-icon tile so it
 * stays crisp at any size. Its colours are theme tokens (--brand-*): red in
 * the light theme, magenta in the dark one.
 */
export default function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="RouteOptima">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "hsl(var(--brand-from))" }} />
          <stop offset="1" style={{ stopColor: "hsl(var(--brand-to))" }} />
        </linearGradient>
        <linearGradient id={`${id}-pin`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.88" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-tile)`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#fff" strokeOpacity="0.18" />
      <ellipse cx="16" cy="25.6" rx="4.2" ry="1.1" style={{ fill: "hsl(var(--brand-shade))" }} fillOpacity="0.35" />
      <path
        fillRule="evenodd"
        fill={`url(#${id}-pin)`}
        d="M16 5.6c-4.1 0-7.4 3.2-7.4 7.2 0 5.3 7.4 12.6 7.4 12.6s7.4-7.3 7.4-12.6c0-4-3.3-7.2-7.4-7.2zm0 4.4a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 1 0 0-5.8z"
      />
    </svg>
  );
}
