import { expect, test } from "@playwright/test";

test("main dashboard route is available", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Emerald Park IT Ticket Dashboard" })).toBeVisible();
});

test("ops route is available and clearly labeled", async ({ page }) => {
  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "Operations Console" })).toBeVisible();
});

test("audit route is available", async ({ page }) => {
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Emerald Park IT Ticket Audit" })).toBeVisible();
});
