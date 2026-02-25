import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkerConfig } from "./config.js";

test("loadWorkerConfig enforces heavy refresh floor", () => {
  const config = loadWorkerConfig({
    CACHE_BACKEND: "file",
    CONFIG_FILE_PATH: "./config/dashboard.config.json",
    POLL_INTERVAL_SECONDS: "900",
    HEAVY_REFRESH_INTERVAL_SECONDS: "60"
  });

  assert.equal(config.pollIntervalSeconds, 900);
  assert.equal(config.heavyRefreshIntervalSeconds, 900);
});
