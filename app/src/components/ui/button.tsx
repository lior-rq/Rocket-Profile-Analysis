import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "border-line bg-panel text-fg hover:bg-panel-2",
        primary: "border-accent bg-accent text-white hover:opacity-90",
        ghost: "border-transparent bg-transparent hover:bg-panel-2",
        danger: "border-err bg-err text-white hover:opacity-90",
        outline: "border-line-strong bg-transparent hover:bg-panel-2",
      },
      size: { default: "h-8 px-3", sm: "h-7 px-2 text-[12px]", lg: "h-10 px-5 text-sm", icon: "h-8 w-8 p-0" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, type = "button", ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} type={asChild ? undefined : type} {...props} />;
});
Button.displayName = "Button";
export { buttonVariants };
