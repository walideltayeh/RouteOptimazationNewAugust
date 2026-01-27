import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2.5 whitespace-nowrap text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B0000] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[#1d1d1f] text-white hover:bg-[#424245] active:bg-[#000000] rounded-full shadow-sm",
        destructive:
          "bg-[#ff3b30] text-white hover:bg-[#ff453a] active:bg-[#d70015] rounded-full shadow-sm",
        outline:
          "border border-[#1d1d1f] dark:border-[#f5f5f7] bg-transparent text-[#1d1d1f] dark:text-[#f5f5f7] hover:bg-[#1d1d1f] hover:text-white dark:hover:bg-[#f5f5f7] dark:hover:text-[#1d1d1f] rounded-full",
        secondary:
          "bg-[#f5f5f7] dark:bg-[#2c2c2e] text-[#1d1d1f] dark:text-white hover:bg-[#e8e8ed] dark:hover:bg-[#3a3a3c] rounded-full",
        ghost: "hover:bg-[#f5f5f7] dark:hover:bg-[#2c2c2e] text-[#1d1d1f] dark:text-white rounded-full",
        link: "text-[#007aff] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-6 py-2.5",
        sm: "h-9 px-5 text-sm",
        lg: "h-12 px-8 text-base",
        icon: "h-10 w-10 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
