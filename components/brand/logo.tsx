import { cn } from "@/lib/utils/cn";

interface LogoProps {
  className?: string;
  size?: number;
  /** "color" = full gradient stroke (light surfaces). "white" = monochrome white outline (dark surfaces). */
  tone?: "color" | "white";
}

export function Logo({ className, size = 32, tone = "color" }: LogoProps) {
  const stroke = tone === "white" ? "#FFFFFF" : "url(#pf-grad)";
  const docFill = tone === "white" ? "transparent" : "#FFFFFF";
  const checkFill = tone === "white" ? "#FFFFFF" : "#4CAF7D";
  const checkStroke = tone === "white" ? "#2D2D2D" : "#FFFFFF";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      width={size}
      height={size}
      className={cn(className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="pf-grad" x1="8" y1="10" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7B6CF6" />
          <stop offset="1" stopColor="#4BBFB0" />
        </linearGradient>
      </defs>
      {/* folder body */}
      <path
        d="M8 22c0-2.2 1.8-4 4-4h12.5l4 4H52c2.2 0 4 1.8 4 4v22c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V22z"
        stroke={stroke}
        strokeWidth={3}
        strokeLinejoin="round"
        fill="none"
      />
      {/* document peeking */}
      <path
        d="M22 14h14l4 4v10c0 1.1-.9 2-2 2H22c-1.1 0-2-.9-2-2V16c0-1.1.9-2 2-2z"
        stroke={stroke}
        strokeWidth={2.5}
        strokeLinejoin="round"
        fill={docFill}
      />
      <line x1="24" y1="20" x2="34" y2="20" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
      <line x1="24" y1="24" x2="32" y2="24" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
      {/* green check badge */}
      <circle cx="48" cy="48" r="9" fill={checkFill} />
      <path
        d="M44 48l3 3 5-5"
        stroke={checkStroke}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({
  className,
  tone = "brand",
  size = 28,
}: {
  className?: string;
  tone?: "brand" | "white";
  size?: number;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Logo size={size} tone={tone === "white" ? "white" : "color"} />
      <span
        className={cn(
          "text-xl font-extrabold tracking-tight leading-none",
          tone === "white" ? "text-white" : "text-brand-gradient"
        )}
      >
        Paperfile
      </span>
    </div>
  );
}
