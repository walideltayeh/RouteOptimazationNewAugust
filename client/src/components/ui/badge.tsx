import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#007aff] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "bg-[#007aff] text-white",
        secondary:
          "bg-[#f5f5f7] dark:bg-[#2c2c2e] text-[#1d1d1f] dark:text-white",
        destructive:
          "bg-[#ff3b30] text-white",
        outline: "border border-[#d2d2d7] dark:border-[#424245] text-[#1d1d1f] dark:text-white bg-transparent",
        success:
          "bg-[#34c759] text-white",
        warning:
          "bg-[#ff9500] text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
