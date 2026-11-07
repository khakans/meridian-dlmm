import { log } from "./logger.js";

export const slackPlainText = value => String(value).replace(/<\/?(?:b|i|code)>/gi, "");

let ownerChannel;

// CLI trades run outside the Socket Mode listener but use the same private DM.
export async function sendSlackNotification(text) {
  const { SLACK_BOT_TOKEN: token, SLACK_TEAM_ID: team, SLACK_OWNER_USER_ID: owner } = process.env;
  if (!token?.startsWith("xoxb-") || !/^T[A-Z0-9]+$/.test(team ?? "") ||
      !/^[UW][A-Z0-9]+$/.test(owner ?? "")) return;
  async function call(method, body = {}) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Slack HTTP failure");
    const data = await response.json();
    if (!data.ok) throw new Error("Slack API failure");
    return data;
  }
  try {
    ownerChannel ??= (async () => {
      const auth = await call("auth.test");
      if (auth.team_id !== team) throw new Error("Slack workspace mismatch");
      const { channel } = await call("conversations.open", { users: owner });
      if (!channel?.id?.startsWith("D")) throw new Error("Slack owner DM unavailable");
      return channel.id;
    })();
    const channel = await ownerChannel;
    await call("chat.postMessage", {
      channel, text: slackPlainText(text).slice(0, 4000), mrkdwn: false,
      unfurl_links: false, unfurl_media: false,
    });
  } catch {
    ownerChannel = undefined;
    log("slack_error", "Could not deliver Meridian notification to owner DM");
  }
}
