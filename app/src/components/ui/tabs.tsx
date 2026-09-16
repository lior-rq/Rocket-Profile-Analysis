import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...p }: TabsPrimitive.TabsListProps) { return <TabsPrimitive.List className={cn("flex flex-wrap gap-1 border-b border-line mb-3", className)} {...p} />; }
export function TabsTrigger({ className, extra, children, ...p }: TabsPrimitive.TabsTriggerProps & { extra?: React.ReactNode }) {
  return <TabsPrimitive.Trigger className={cn("-mb-px border-b-2 border-transparent px-3 py-1.5 text-[13px] text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg", className)} {...p}>{children}{extra != null && extra !== "" ? <span className="ml-1.5 rounded-full bg-panel-2 px-1.5 text-[11px]">{extra}</span> : null}</TabsPrimitive.Trigger>;
}
export const TabsContent = TabsPrimitive.Content;
