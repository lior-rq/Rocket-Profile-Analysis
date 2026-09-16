import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Shell } from "@/components/Shell";
import { OverviewPage } from "@/pages/Overview";
import { InputsPage } from "@/pages/Inputs";
import { AeroPage } from "@/pages/Aero";
import { ReferencePage } from "@/pages/Reference";
import { ValidatePage } from "@/pages/Validate";
import { OptimizePage } from "@/pages/Optimize";
import { ResultsPage } from "@/pages/Results";
import { ConfirmPage } from "@/pages/Confirm";
import { RunsPage } from "@/pages/Runs";
import { EnginePage } from "@/pages/Engine";
import { SettingsPage } from "@/pages/Settings";
import { SetupPage } from "@/pages/Setup";

const rootRoute = createRootRoute({ component: Shell });
const anySearch = (s: Record<string, unknown>) => s as Record<string, string | undefined>;
const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/inputs", component: InputsPage, validateSearch: anySearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/aero", component: AeroPage, validateSearch: anySearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/reference", component: ReferencePage, validateSearch: anySearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/validate", component: ValidatePage, validateSearch: anySearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/optimize", component: OptimizePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/results", component: ResultsPage, validateSearch: anySearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/confirm", component: ConfirmPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: RunsPage, validateSearch: anySearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/engine", component: EnginePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupPage }),
];
const routeTree = rootRoute.addChildren(routes);
export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: false });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
