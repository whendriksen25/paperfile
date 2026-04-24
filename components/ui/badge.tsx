import * as React from "react";
import { cn } from "@/lib/utils/cn";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-3 py-1 rounded-full",
  {
    variants: {
      variant: {
        default: "bg-muted text-muted-foreground",
        purple: "bg-brand-purple/12 text-brand-purple",
        blue: "bg-brand-blue/12 text-brand-blue",
        teal: "bg-brand-teal/12 text-brand-teal",
        green: "bg-brand-green/12 text-brand-green",
        warning: "bg-amber-100 text-amber-700",
        destructive: "bg-destructive/10 text-destructive",
        match:
          "bg-brand-blue text-white text-[10px] py-0.5 px-2 normal-case",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
