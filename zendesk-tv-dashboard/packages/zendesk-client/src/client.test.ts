import test from "node:test";
import assert from "node:assert/strict";
import { ZendeskClient } from "./client.js";

test("fromEnv rejects placeholder subdomain", () => {
  assert.throws(
    () =>
      ZendeskClient.fromEnv({
        ZENDESK_SUBDOMAIN: "your-subdomain",
        ZENDESK_EMAIL: "agent@example.com",
        ZENDESK_API_TOKEN: "token"
      }),
    /Invalid ZENDESK_SUBDOMAIN/
  );
});
