import { log } from "./logger.js";
import bs58 from "bs58";

export const slackPlainText = value => String(value).replace(/<\/?(?:b|i|code)>/gi, "");
const reportHeadings = new Set(["Posisi & PnL", "Sinyal · 24 jam", "Screening Discovery · sejak restart", "Diagnostik"]);

export function slackMessageBlocks(text) {
  return (text.match(/[\s\S]{1,2800}/gu) ?? []).map(part => {
    const elements = [];
    let formatted = false;
    for (const line of part.split("\n")) {
      if (reportHeadings.has(line) || /^📊 Meridian • (LIVE|SHADOW)$/.test(line)) {
        elements.push({ type: "text", text: line, style: { bold: true } }, { type: "text", text: "\n" });
        formatted = true;
        continue;
      }
      const match = /^(Wallet|Wallet on-chain|Deposit address|Wallet address|Mint|Pool|Position|Tx)(?::| )\s*([1-9A-HJ-NP-Za-km-z]{32,88})$/.exec(line);
      if (match) {
        const [, label, id] = match;
        const tx = label === "Tx";
        if (bs58.decode(id).length === (tx ? 64 : 32)) {
          const explorer = label === "Pool" ? "Meteora" : "Solscan";
          const url = label === "Pool" ? `https://app.meteora.ag/dlmm/${id}`
            : `https://solscan.io/${tx ? "tx" : label === "Mint" ? "token" : "account"}/${id}`;
          if (label === "Wallet") {
            elements.push({ type: "text", text: "Wallet " },
              { type: "text", text: `${id.slice(0, 4)}…${id.slice(-4)}`, style: { code: true } },
              { type: "text", text: " · " }, { type: "link", url, text: explorer }, { type: "text", text: "\n" });
          } else {
            elements.push({ type: "text", text: `${label} · ` }, { type: "link", url, text: explorer },
              { type: "text", text: "\n" }, { type: "text", text: id, style: { code: true } }, { type: "text", text: "\n" });
          }
          formatted = true;
          continue;
        }
      }
      elements.push({ type: "text", text: `${line}\n` });
    }
    if (!formatted) return { type: "section", text: { type: "plain_text", text: part } };
    elements.at(-1).text = elements.at(-1).text.slice(0, -1);
    if (!elements.at(-1).text) elements.pop();
    return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
  });
}

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
    const body = slackPlainText(text).slice(0, 4000);
    await call("chat.postMessage", {
      channel, text: body, blocks: slackMessageBlocks(body), mrkdwn: false,
      unfurl_links: false, unfurl_media: false,
    });
  } catch {
    ownerChannel = undefined;
    log("slack_error", "Could not deliver Meridian notification to owner DM");
  }
}
