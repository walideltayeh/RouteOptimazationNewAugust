import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full rounded-xl border border-[#d2d2d7] dark:border-[#424245] bg-white dark:bg-[#1c1c1e] px-4 py-2.5 text-base text-[#1d1d1f] dark:text-white ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[#86868b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B0000] focus-visible:border-[#8B0000] disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
