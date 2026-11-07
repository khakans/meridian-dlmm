import { randomUUID } from "node:crypto";
import bolt from "@slack/bolt";
import { log } from "../logger.js";
import { slackPlainText as plain } from "../slack-notify.js";
import { ADMIN_COMMANDS, createAdminConsole } from "./telegram-admin.js";

const { App } = bolt;
const MENU_TTL = 5 * 60_000;
const COMMANDS = new Set([...ADMIN_COMMANDS.map(({ command }) => command), "start", "help"]);

const plainText = text => ({ type: "plain_text", text });

// This console has one owner and one DM. A new render invalidates every old button.
export function createSlackConsole({ client, channel, team, owner, appId, ...adminOptions }) {
  let card;
  let queue = Promise.resolve();
  let closed = false;
  const received = new Map();
  const sendMessage = value => {
    const text = plain(value).slice(0, 4000);
    const blocks = text.includes("\n")
      ? text.match(/[\s\S]{1,2800}/gu).map(part => ({ type: "section", text: plainText(part) }))
      : undefined;
    return client.chat.postMessage({ channel, text, blocks, mrkdwn: false, unfurl_links: false, unfurl_media: false });
  };

  async function render(view, page, ts) {
    const nonce = randomUUID();
    const paragraphs = plain(view.text).match(/[\s\S]{1,2800}/gu) ?? ["Meridian"];
    const rows = view.keyboard ?? [];
    const pageCount = Math.max(paragraphs.length, Math.ceil(rows.length / 20));
    const actions = new Map();
    const button = (label, action) => {
      const value = `${nonce}:${actions.size}`;
      actions.set(value, action);
      return { type: "button", action_id: `meridian_${actions.size}`, text: plainText(plain(label).slice(0, 70) || "Open"), value };
    };
    const text = paragraphs[page] ?? paragraphs[0];
    const blocks = [{ type: "section", text: plainText(text) }];
    for (const row of rows.slice(page * 20, (page + 1) * 20)) {
      blocks.push({ type: "actions", elements: row.map(b => button(b.text, { data: b.callback_data })) });
    }
    if (pageCount > 1) {
      const elements = [];
      if (page > 0) elements.push(button("Previous page", { page: page - 1 }));
      if (page + 1 < pageCount) elements.push(button("Next page", { page: page + 1 }));
      blocks.push({ type: "actions", elements });
    }
    const message = { channel, text, blocks, mrkdwn: false };
    card = undefined;
    const response = ts
      ? await client.chat.update({ ...message, ts })
      : await client.chat.postMessage({ ...message, unfurl_links: false, unfurl_media: false });
    if (!response.ok || !response.ts) throw new Error("Slack card delivery failed");
    card = { view, ts: response.ts, expires: Date.now() + MENU_TTL, actions };
    return { ok: true, result: { message_id: response.ts } };
  }

  const onUpdate = createAdminConsole({
    sendMessage,
    sendMenu: (text, keyboard) => render({ text, keyboard }, 0),
    editMenu: (ts, text, keyboard) => render({ text, keyboard }, 0, ts),
  }, { ...adminOptions, slack: true });

  function enqueue(id, fn) {
    if (closed || !id || received.has(id)) return;
    const now = Date.now();
    for (const [key, expiry] of received) {
      if (expiry > now) break;
      received.delete(key);
    }
    // Slack retries deliver the same event/trigger ID. Keep a bounded retry window.
    if (received.size >= 4096) return;
    received.set(id, now + MENU_TTL);
    const waitNotice = setTimeout(() => {
      if (!closed) void sendMessage("Oke, gw cek dulu ya.").catch(() => {});
    }, 5000);
    waitNotice.unref();
    queue = queue.then(async () => {
      if (!closed) await fn();
    }).catch(() => {
      log("slack_error", "Meridian admin request failed");
      return sendMessage("Permintaan gagal. Coba menu lagi.").catch(() => {});
    }).finally(() => clearTimeout(waitNotice));
    return queue;
  }

  function authorized(teamId, userId, channelId, incomingAppId) {
    return teamId === team && userId === owner && channelId === channel && incomingAppId === appId;
  }

  return {
    sendMessage,
    stop() { closed = true; },
    message(body, event) {
      if (!authorized(body.team_id, event.user, event.channel, body.api_app_id) ||
          event.channel_type !== "im" || event.subtype || event.bot_id || typeof event.text !== "string") return;
      const text = event.text.trim();
      if (!text) return;
      const first = text.split(/\s/, 1)[0];
      const command = first.replace(/^[/!]/, "");
      const input = COMMANDS.has(command) ? `/${command}${text.slice(first.length)}` : text;
      return enqueue(body.event_id, () => onUpdate({ message: { text: input } }));
    },
    action(body, action) {
      if (!authorized(body.team?.id, body.user?.id, body.channel?.id, body.api_app_id) ||
          body.container?.type !== "message") return;
      return enqueue(body.trigger_id, async () => {
        const selected = card && card.ts === body.container.message_ts && card.expires > Date.now()
          ? card.actions.get(action.value) : undefined;
        if (!selected) return sendMessage("Tombol sudah kedaluwarsa. Ketik menu untuk membuka lagi.");
        if (selected.page !== undefined) return render(card.view, selected.page, card.ts);
        const messageId = card.ts;
        card.actions.delete(action.value);
        return onUpdate({ callback: { message: { message_id: messageId }, data: selected.data } });
      });
    },
    command(body) {
      if (!authorized(body.team_id, body.user_id, body.channel_id, body.api_app_id)) return;
      const command = body.command.replace(/^\/meridian-/, "");
      if (!COMMANDS.has(command)) return;
      return enqueue(body.trigger_id, () => onUpdate({ message: { text: `/${command} ${body.text ?? ""}` } }));
    },
  };
}

export async function startSlackAdmin(options = {}) {
  const { SLACK_BOT_TOKEN: token, SLACK_APP_TOKEN: appToken, SLACK_TEAM_ID: team,
    SLACK_OWNER_USER_ID: owner, SLACK_APP_ID: appId } = process.env;
  if (!token && !appToken) return null;
  if (!token?.startsWith("xoxb-") || !appToken?.startsWith("xapp-") ||
      !/^T[A-Z0-9]+$/.test(team ?? "") || !/^[UW][A-Z0-9]+$/.test(owner ?? "") ||
      !/^A[A-Z0-9]+$/.test(appId ?? "")) {
    log("slack_warn", "Slack disabled: complete the five dedicated Meridian Slack settings");
    return null;
  }
  const app = new App({ token, appToken, socketMode: true, clientOptions: { timeout: 8000, retryConfig: { retries: 0 } } });
  try {
    const auth = await app.client.auth.test();
    if (auth.team_id !== team) throw new Error("Slack workspace mismatch");
    const opened = await app.client.conversations.open({ users: owner });
    const channel = opened.channel?.id;
    if (!channel?.startsWith("D")) throw new Error("Slack owner DM unavailable");
    const console = createSlackConsole({ client: app.client, channel, team, owner, appId, ...options });
    app.event("message", ({ body, event }) => console.message(body, event));
    app.action(/^meridian_/, async ({ ack, body, action }) => {
      await ack();
      await console.action(body, action);
    });
    for (const { command } of ADMIN_COMMANDS) {
      app.command(`/meridian-${command}`, async ({ ack, body }) => {
        await ack();
        await console.command(body);
      });
    }
    app.error(async () => { log("slack_error", "Slack adapter could not process an event"); });
    await app.start();
    log("slack", "Meridian Slack Socket Mode connected to owner DM");
    return {
      sendMessage: console.sendMessage,
      async stop() { console.stop(); await app.stop(); },
    };
  } catch {
    await app.stop().catch(() => {});
    log("slack_error", "Slack startup failed. Check app tokens, workspace, owner and scopes.");
    return null;
  }
}
