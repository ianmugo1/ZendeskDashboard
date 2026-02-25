import test from "node:test";
import assert from "node:assert/strict";
import { loadApiConfig } from "./config.js";

test("loadApiConfig parses CORS origins and api token", () => {
  const config = loadApiConfig({
    CACHE_BACKEND: "file",
    METRICS_CORS_ORIGINS: "http://localhost:3000,https://dashboard.example.com",
    METRICS_API_TOKEN: "secret-token"
  });

  assert.deepEqual(config.corsOrigins, ["http://localhost:3000", "https://dashboard.example.com"]);
  assert.equal(config.apiToken, "secret-token");
});
