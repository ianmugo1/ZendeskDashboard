import assert from "node:assert/strict";
import test from "node:test";
import { isStaticAssetPath } from "./middleware";

test("isStaticAssetPath matches Next static and file assets", () => {
  assert.equal(isStaticAssetPath("/_next/static/chunks/app.js"), true);
  assert.equal(isStaticAssetPath("/_next/image?url=%2Flogo.png"), true);
  assert.equal(isStaticAssetPath("/favicon.ico"), true);
  assert.equal(isStaticAssetPath("/images/splash.webp"), true);
  assert.equal(isStaticAssetPath("/api/snapshot"), false);
  assert.equal(isStaticAssetPath("/ops"), false);
  assert.equal(isStaticAssetPath("/audit"), false);
});
