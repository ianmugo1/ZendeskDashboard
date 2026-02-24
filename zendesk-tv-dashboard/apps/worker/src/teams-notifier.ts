import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import type { Logger } from "pino";
import type { TeamsNotifyConfig } from "./config.js";

interface TeamsNotifier {
  maybeNotify(snapshot: ZendeskSnapshot): Promise<void>;
}

function fileExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\") || command.includes(":");
}

function buildBrowserCandidates(config: TeamsNotifyConfig): string[] {
  const candidates: string[] = [];

  if (config.screenshotBrowserPath) {
    candidates.push(config.screenshotBrowserPath);
  }

  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "msedge",
      "chrome"
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "google-chrome",
      "chromium"
    );
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "google-chrome", "chromium-browser", "chromium");
  }

  return Array.from(new Set(candidates));
}

function withBasicAuth(urlValue: string, username: string | null, password: string | null): string {
  if (!username || !password) {
    return urlValue;
  }

  const url = new URL(urlValue);
  if (!url.username && !url.password) {
    url.username = username;
    url.password = password;
  }
  return url.toString();
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Screenshot command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Screenshot command exited with code ${code}. ${stderr.trim()}`));
    });
  });
}

async function captureScreenshot(config: TeamsNotifyConfig): Promise<void> {
  if (!config.screenshotCaptureUrl) {
    return;
  }

  const captureUrl = withBasicAuth(
    config.screenshotCaptureUrl,
    config.screenshotBasicAuthUsername,
    config.screenshotBasicAuthPassword
  );

  await fsPromises.mkdir(path.dirname(config.screenshotFilePath), { recursive: true });

  const args = [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${config.screenshotWidth},${config.screenshotHeight}`,
    `--screenshot=${config.screenshotFilePath}`,
    "--virtual-time-budget=15000",
    captureUrl
  ];

  const candidates = buildBrowserCandidates(config);
  const errors: string[] = [];

  for (const candidate of candidates) {
    if (isPathLike(candidate) && !fileExists(candidate)) {
      continue;
    }

    try {
      await runCommand(candidate, args, config.screenshotTimeoutMs);
      return;
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Unable to capture screenshot. Tried browsers: ${errors.join(" | ")}`);
}

function buildTeamsPayload(snapshot: ZendeskSnapshot, dashboardUrl: string, imageUrl: string | null): unknown {
  const plainMessage = [
    `Emerald Park IT Ticket Dashboard`,
    `Generated: ${snapshot.generated_at}`,
    `Unsolved: ${snapshot.unsolved_count}`,
    `SLA (7d): ${snapshot.sla_health_7d.combined_within_target_pct.toFixed(1)}%`,
    `Created Today: ${snapshot.daily_summary.created_today}`,
    `Solved (7d): ${snapshot.daily_summary.solved_count_7d}`,
    `Open Dashboard: ${dashboardUrl}`,
    imageUrl ? `Screenshot: ${imageUrl}` : null
  ]
    .filter(Boolean)
    .join("\n");

  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: "Emerald Park IT Ticket Dashboard",
      weight: "Bolder",
      size: "Large"
    },
    {
      type: "TextBlock",
      text: `Snapshot generated: ${snapshot.generated_at}`,
      isSubtle: true,
      spacing: "None"
    },
    {
      type: "FactSet",
      facts: [
        { title: "Unsolved", value: String(snapshot.unsolved_count) },
        { title: "SLA (7d)", value: `${snapshot.sla_health_7d.combined_within_target_pct.toFixed(1)}%` },
        { title: "Created Today", value: String(snapshot.daily_summary.created_today) },
        { title: "Solved (7d)", value: String(snapshot.daily_summary.solved_count_7d) },
        { title: "Active Alerts", value: String(snapshot.alerts.active_count) }
      ]
    }
  ];

  if (imageUrl) {
    body.push({
      type: "Image",
      url: imageUrl,
      altText: "Latest dashboard screenshot",
      size: "Stretch"
    });
  }

  return {
    message: plainMessage,
    text: plainMessage,
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          actions: [
            {
              type: "Action.OpenUrl",
              title: "Open Dashboard",
              url: dashboardUrl
            }
          ]
        }
      }
    ]
  };
}

class NoopTeamsNotifier implements TeamsNotifier {
  async maybeNotify(_snapshot: ZendeskSnapshot): Promise<void> {
    return;
  }
}

class WebhookTeamsNotifier implements TeamsNotifier {
  private lastSentAtMs = 0;
  private readonly warnedMissingConfig: { webhook: boolean; dashboard: boolean } = {
    webhook: false,
    dashboard: false
  };

  constructor(private readonly config: TeamsNotifyConfig, private readonly logger: Logger) {}

  async maybeNotify(snapshot: ZendeskSnapshot): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (!this.config.webhookUrl) {
      if (!this.warnedMissingConfig.webhook) {
        this.warnedMissingConfig.webhook = true;
        this.logger.warn("Teams notifications enabled but TEAMS_WEBHOOK_URL is missing.");
      }
      return;
    }

    if (!this.config.dashboardPublicUrl) {
      if (!this.warnedMissingConfig.dashboard) {
        this.warnedMissingConfig.dashboard = true;
        this.logger.warn("Teams notifications enabled but DASHBOARD_PUBLIC_URL is missing.");
      }
      return;
    }

    const nowMs = Date.now();
    if (nowMs - this.lastSentAtMs < this.config.notifyIntervalSeconds * 1000) {
      return;
    }

    let imageUrl: string | null = null;
    try {
      if (this.config.screenshotCaptureUrl) {
        await captureScreenshot(this.config);
      }

      if (this.config.screenshotPublicUrl && fileExists(this.config.screenshotFilePath)) {
        imageUrl = `${this.config.screenshotPublicUrl}${this.config.screenshotPublicUrl.includes("?") ? "&" : "?"}ts=${encodeURIComponent(snapshot.generated_at)}`;
      }
    } catch (error) {
      this.logger.warn(
        {
          err: error
        },
        "Failed to capture dashboard screenshot for Teams notification"
      );
    }

    const payload = buildTeamsPayload(snapshot, this.config.dashboardPublicUrl, imageUrl);
    const response = await fetch(this.config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Teams webhook post failed with status ${response.status}. ${body}`);
    }

    this.lastSentAtMs = nowMs;
    this.logger.info(
      {
        generated_at: snapshot.generated_at,
        image_attached: Boolean(imageUrl)
      },
      "Posted dashboard update to Teams"
    );
  }
}

export function createTeamsNotifier(config: TeamsNotifyConfig, logger: Logger): TeamsNotifier {
  if (!config.enabled) {
    return new NoopTeamsNotifier();
  }
  return new WebhookTeamsNotifier(config, logger);
}
