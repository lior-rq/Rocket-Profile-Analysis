import { expect, test, type Page } from "@playwright/test";

const ROUTES = ["/", "/inputs", "/inputs?tab=motors", "/inputs?tab=mass", "/inputs?tab=target", "/optimize", "/results", "/results?tab=matrix", "/results?tab=tradespace", "/results?tab=shortlist", "/results?tab=customize", "/results?tab=eligibility", "/results?tab=characterization", "/results?tab=plots", "/results?tab=previous", "/results?tab=report", "/confirm", "/runs", "/engine", "/settings", "/setup"];

async function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|ERR_CONNECTION|net::/i.test(m.text())) errors.push("console: " + m.text()); });
  // the console line for a failed fetch has no URL; record it here
  page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`); });
  return errors;
}

test("every page renders without errors", async ({ page }) => {
  const errors = await collectErrors(page);
  for (const r of ROUTES) {
    await page.goto(r);
    await expect(page.getByText("Rocket Profile Analysis").first()).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page.locator("main")).not.toContainText("Connecting…", { timeout: 15_000 });
  }
  expect(errors, errors.join("\n")).toEqual([]);
});

test("overview shows the project and the engine", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Vehicle & target")).toBeVisible();
  await expect(page.getByText(/engine: (ready|missing)/)).toBeVisible();
});

test("results table has rows and a design detail", async ({ page }) => {
  await page.goto("/results");
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
  await expect(page.getByText("Flight configuration")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("table tbody tr").first()).toBeVisible();
});

test("a check runs in-process and the log shows it", async ({ page }) => {
  await page.goto("/inputs");
  const btn = page.getByRole("button", { name: "Check inputs" });
  await expect(btn).toBeEnabled({ timeout: 15_000 });
  await btn.click();
  await expect(page.getByText(/--- check (finished|failed)/).first()).toBeVisible({ timeout: 60_000 });
});
