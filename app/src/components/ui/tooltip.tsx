import * as T from "@radix-ui/react-tooltip";
export const TooltipProvider = T.Provider;
export function Tip({ text, children }: { text: React.ReactNode; children: React.ReactElement }) {
  if (!text) return children;
  return <T.Root delayDuration={300}><T.Trigger asChild>{children}</T.Trigger><T.Portal><T.Content sideOffset={4} className="z-50 max-w-[320px] rounded-md border border-line bg-panel px-2 py-1 text-[12px] shadow-md">{text}</T.Content></T.Portal></T.Root>;
}
