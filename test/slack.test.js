import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSlackConsole } from "../standalone/slack-admin.js";
import { _test } from "../standalone/telegram-admin.js";
import { notifyClose, notifyDeploy, notifySwap, sendNotification, setNotificationMirror } from "../telegram.js";
import { repoPath } from "../repo-root.js";
import { slackMessageBlocks } from "../slack-notify.js";
import bs58 from "bs58";

test("Slack formats only labelled complete public identifiers", () => {
  const id = bs58.encode(Buffer.alloc(32, 9));
  const sig = bs58.encode(Buffer.alloc(64, 7));
  const blocks = slackMessageBlocks(`Wallet on-chain ${id}\nMint ${id}\nPool ${id}\nTx: ${sig}\nPrivate key: ${sig}`);
  const elements = blocks[0].elements[0].elements;
  assert.deepEqual(elements.filter(e => e.style?.code).map(e => e.text), [id, id, id, sig]);
  assert.deepEqual(elements.filter(e => e.type === "link").map(e => e.url), [
    `https://solscan.io/account/${id}`, `https://solscan.io/token/${id}`,
    `https://app.meteora.ag/dlmm/${id}`, `https://solscan.io/tx/${sig}`,
  ]);
});

test("Slack owner DM reuses every admin section and rejects stale, repeated and foreign actions", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network disabled in Slack console test"); });
  const files = new Map();
  const paths = new Set([".env", "user-config.json", "smart-wallets.json"].map(name => repoPath(name)));
  const original = { exists: fs.existsSync, read: fs.readFileSync, write: fs.writeFileSync };
  t.mock.method(fs, "existsSync", p => paths.has(p) ? files.has(p) : original.exists(p));
  t.mock.method(fs, "readFileSync", (p, ...args) => files.has(p) ? files.get(p) : original.read(p, ...args));
  t.mock.method(fs, "writeFileSync", (p, value, ...args) => paths.has(p) ? files.set(p, value) : original.write(p, value, ...args));
  files.set(repoPath(".env"), "RPC_URL=https://rpc.example/?api-key=SECRET_SENTINEL\nJUPITER_API_KEY=SECRET_SENTINEL\nDRY_RUN=true\n");

  let ts = 0;
  let request = 0;
  let card;
  let restarts = 0;
  const replies = [];
  const client = { chat: {
    async postMessage(body) {
      const saved = { ...body, ok: true, ts: String(++ts) };
      replies.push(saved);
      if (saved.blocks) card = saved;
      return saved;
    },
    async update(body) {
      assert.equal(body.ts, card.ts);
      card = { ...body, ok: true };
      replies.push(card);
      return card;
    },
  } };
  const slack = createSlackConsole({
    client, channel: "D1", owner: "U1", team: "T1", appId: "A1",
    restart: async () => { restarts++; },
    positionDetails: async (tab, page) => ({
      text: `Positions · ${tab} · Halaman ${page + 1}/2`,
      tab, page, pages: 2, tabs: ["open", "closed", "cancelled"],
    }),
  });
  const message = (text, event = {}, body = {}) => slack.message(
    { team_id: "T1", api_app_id: "A1", event_id: String(++request), ...body },
    { channel: "D1", channel_type: "im", user: "U1", text, ...event },
  );
  const buttons = () => card.blocks.flatMap(block => block.elements ?? []);
  const find = label => {
    const button = buttons().find(item => item.text.text.includes(label));
    assert.ok(button, `Missing button ${label}`);
    return button;
  };
  const click = (button, overrides = {}) => slack.action({
    team: { id: "T1" }, user: { id: "U1" }, channel: { id: "D1" },
    api_app_id: "A1", container: { type: "message", message_ts: card.ts },
    trigger_id: String(++request), ...overrides,
  }, button);
  const slash = (command, text = "") => slack.command({
    team_id: "T1", user_id: "U1", channel_id: "D1", api_app_id: "A1",
    command: `/meridian-${command}`, text, trigger_id: String(++request),
  });

  await message("menu", { user: "U2" });
  await message("menu", { channel_type: "channel" });
  await message("menu", { bot_id: "B1" });
  await message("menu", {}, { api_app_id: "A2" });
  assert.equal(replies.length, 0);
  await slash("menu");
  const menuTs = card.ts;
  await click(find("Positions"));
  assert.match(card.text, /open · Halaman 1/);
  await click(find("Berikutnya"));
  assert.match(card.text, /open · Halaman 2/);
  await click(find("Riwayat tutup"));
  assert.match(card.text, /closed · Halaman 1/);
  await click(find("Muat ulang"));
  assert.match(card.text, /closed · Halaman 1/);
  await click(find("Back"));
  for (const section of _test.SECTIONS) {
    await click(find(section.title));
    let visible = buttons().map(b => b.text.text);
    if (visible.includes("Next page")) {
      await click(find("Next page"));
      visible = visible.concat(buttons().map(b => b.text.text));
    }
    for (const setting of section.settings) {
      assert.ok(visible.some(label => label.startsWith(`${setting.label ?? setting.k}:`)), setting.k);
    }
    await message("menu");
    assert.equal(card.ts, menuTs);
  }
  await click(find("RPC & data"));
  await click(find("JUPITER_API_KEY"));
  assert.match(card.text, /server .env/);
  await click(find("RPC_URL (default)"));
  await message("<https://rpc-new.example|https://rpc-new.example>");
  assert.match(files.get(repoPath(".env")), /RPC_URL=https:\/\/rpc-new.example/);
  await message("menu");
  await click(find("Bot key"));
  assert.ok(!buttons().some(b => b.text.text.includes("Export")));
  await click(find("Signing key setup"));
  assert.match(card.text, /server .env/);
  await click(find("Set read-only address"));
  await slash("cancel");
  assert.match(card.text, /Cancelled/);
  assert.ok(!files.has(repoPath("user-config.json")));

  const address = "11111111111111111111111111111111";
  await slash("addwallet", `${address} Watch`);
  await slash("wallets");
  assert.match(card.text, /Watch/);
  await slash("removewallet", address);
  assert.match(card.text, /Removed Watch/);
  await slash("status");
  assert.match(card.text, /Monitor:/);
  await message("menu");
  await click(find("Shadow: ON"));
  await click(find("LIVE"));
  assert.match(replies.at(-1).text, /Live requires/);
  assert.ok(!files.has(repoPath("user-config.json")));
  await message("menu");
  await click(find("Restart bot"));
  const confirm = find("Confirm restart");
  await click(confirm, { user: { id: "U2" } });
  assert.equal(restarts, 0);
  await click(confirm);
  await click(confirm);
  assert.equal(restarts, 1);
  const old = find("Cancel");
  await message("menu");
  await click(old);
  assert.match(replies.at(-1).text, /kedaluwarsa/);
  assert.ok(!JSON.stringify(replies).includes("SECRET_SENTINEL"));
  slack.stop();
});

test("Slack mirror receives lifecycle, proposal, deploy, close and swap notifications", async t => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ ok: true }) }));
  const received = [];
  setNotificationMirror(async text => { received.push(text); });
  try {
    await sendNotification("Meridian started");
    await sendNotification("Shadow proposal");
    await notifyDeploy({ pair: "TEST/SOL", amountSol: 1, position: "position", tx: "receipt" });
    await notifyClose({ pair: "TEST/SOL", pnlUsd: 1, pnlPct: 2 });
    await notifySwap({ inputSymbol: "TEST", outputSymbol: "SOL", tx: "receipt" });
    await sendNotification("Meridian stopped");
    assert.deepEqual(received.map(text => text.match(/started|proposal|Deployed|Closed|Swapped|stopped/)[0]),
      ["started", "proposal", "Deployed", "Closed", "Swapped", "stopped"]);
  } finally {
    setNotificationMirror(null);
  }
});
