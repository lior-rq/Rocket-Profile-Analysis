import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui";
import "@/store/ui";
import { router } from "./router";
import "./index.css";

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 2000, retry: 1 } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster position="bottom-center" offset={72} gap={8} closeButton
                   toastOptions={{ unstyled: true, classNames: { toast: "toast glass-strong", success: "success", error: "error", warning: "warning", info: "info" } }} />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  </React.StrictMode>,
);
