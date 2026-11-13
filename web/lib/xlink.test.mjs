// lib/explorer/xlink.ts: an account's linked X handle, read from its own history
// (docs/X-LINKING.md), the form fields that record one, and what the record costs. The record's
// rules and the proof code are the SDK's (sdk-ts/test/xlink.ts). Run with `npm test -w @blockula/web`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { xLinkCode } from "@blockula/sdk";
import { checkField } from "./explorer/fields.ts";
import { preflight } from "./explorer/preflight.ts";
import { RECENT_TXS, X_PAGES, ownerKeyIds, readXLink, xLinkIn, xLinkKey, xRecordMemo } from "./explorer/xlink.ts";

const CHAIN = { chainId: "blockula-dev", genesisHash: "ab".repeat(32) };
const ME = "boo1k3cts6u53yggzevug89yxy5u5n73xmxjglkt6zua8uph75s4lmwshek62a";
const OTHER = "boo1y9759xh6spqxrvj4fx6l28jeeq9nywxp9uz78026w5q6kfhk5llq9tpczh";
const who = (address) => ({ address, name: null, short: address });
const owner = { key_id: "k-owner", label: "laptop", role: { type: "owner" }, added_at: 0, spent_this_period: "0", window_start: 0 };
const agent = { key_id: "k-agent", label: "claude", role: { type: "session", limit: "1", period_blocks: 10, expires_at: 99 }, added_at: 1, spent_this_period: "0", window_start: 0 };
let n = 0;
const tx = (memo, o = {}) => ({ id: `t${++n}`, summary: "", kind: "transfer", status: "finalized", error: null, height: 1000 - n, from: who(ME), to: who(ME), signer_key: "k-owner", amount: null, memo, ...o });
const account = (recent_txs, o = {}) => ({ account: who(ME), nonce: 7, keys: [owner, agent], recent_txs, ...o });
const never = () => assert.fail("the history wasn't needed");

test("the newest record in a stretch of history decides: a link, an unlink, or nothing here", () => {
  const link = xLinkIn([tx("gm"), tx("x-link:v1:BlockulaChain:20", { id: "rec" }), tx("x-link:v1:older:10")], ME, ["k-owner"], CHAIN);
  assert.deepEqual([link.handle, link.post_id, link.tx, link.post_url, link.profile_url], ["BlockulaChain", "20", "rec", "https://x.com/BlockulaChain/status/20", "https://x.com/BlockulaChain"]);
  assert.equal(link.code, xLinkCode(CHAIN, ME, "BlockulaChain"), "the code the post must hold, for this chain and account");
  assert.equal(xLinkIn([tx("x-unlink:v1"), tx("x-link:v1:BlockulaChain:20")], ME, ["k-owner"], CHAIN), null);
  assert.equal(xLinkIn([tx("gm"), tx("x-link:v1:jack:20", { to: who(OTHER) }), tx("x-link:v1:jack:20", { signer_key: "k-agent" }), tx("x-link:v1:jack:20", { status: "pending", height: null })], ME, ["k-owner"], CHAIN), undefined);
  assert.deepEqual(ownerKeyIds([owner, agent]), ["k-owner"]);
});

test("a link in the account's recent transactions needs no more reads", async () => {
  assert.equal((await readXLink(never, account([tx("gm"), tx("x-link:v1:BlockulaChain:20")]), CHAIN)).handle, "BlockulaChain");
  assert.equal(await readXLink(never, account([tx("x-unlink:v1"), tx("x-link:v1:BlockulaChain:20")]), CHAIN), null);
  // Fewer than a full page and no record: that's the whole history, so there's no link.
  assert.equal(await readXLink(never, account([tx("gm"), tx("hello")]), CHAIN), null);
  // An account with no owner keys (a system account, a program) has no records.
  assert.equal(await readXLink(never, account([tx("x-link:v1:BlockulaChain:20")], { keys: [agent] }), CHAIN), null);
});

test("a busy account's record is found further back, a page at a time, and not forever", async () => {
  const busy = Array.from({ length: RECENT_TXS }, () => tx("gm"));
  const asked = [];
  const pages = { "": { txs: [tx("gm")], next: "900.1" }, "900.1": { txs: [tx("gm"), tx("x-link:v1:BlockulaChain:20")], next: "800.0" } };
  const get = async (path) => {
    asked.push(path);
    return pages[new URL(path, "http://n").searchParams.get("before") ?? ""];
  };
  assert.equal((await readXLink(get, account(busy), CHAIN)).post_id, "20");
  assert.deepEqual(asked, [`/account/${ME}/txs?limit=100`, `/account/${ME}/txs?limit=100&before=900.1`]);

  // Pending transactions don't count toward "a full page of history".
  assert.equal(await readXLink(never, account([...busy.slice(1), tx("gm", { status: "pending", height: null })]), CHAIN), null);

  // No record anywhere: it stops at the end of the history, or after X_PAGES pages.
  let reads = 0;
  assert.equal(await readXLink(async () => (++reads, { txs: [tx("gm")], next: null }), account(busy), CHAIN), null);
  assert.equal(reads, 1);
  reads = 0;
  assert.equal(await readXLink(async () => (++reads, { txs: [tx("gm")], next: String(reads) }), account(busy), CHAIN), null);
  assert.equal(reads, X_PAGES);
  // A node whose answer isn't a list of transactions has nothing to say.
  assert.equal(await readXLink(async () => ({ txs: "nope", next: null }), account(busy), CHAIN), null);
});

test("a link is read again only when the account's nonce, owner keys or chain change", () => {
  const a = account([]);
  const key = xLinkKey("http://node", a, CHAIN);
  assert.equal(xLinkKey("http://node", account([tx("gm")]), CHAIN), key, "new activity from others doesn't change it");
  for (const other of [xLinkKey("http://node", { ...a, nonce: 8 }, CHAIN), xLinkKey("http://node", { ...a, keys: [agent] }, CHAIN), xLinkKey("http://other", a, CHAIN), xLinkKey("http://node", a, { ...CHAIN, chainId: "blockula-1" }), xLinkKey("http://node", { ...a, account: who(OTHER) }, CHAIN)]) assert.notEqual(other, key);
});

test("the form's fields: a handle and a post's link, as people paste them", () => {
  const field = (type, v) => checkField({ type }, v, "boo");
  for (const ok of ["BlockulaChain", "@BlockulaChain", "https://x.com/BlockulaChain"]) assert.equal(field("x_handle", ok), null, ok);
  assert.equal(field("x_handle", "not a handle"), "An X handle is 1 to 15 letters, digits or underscores.");
  assert.equal(field("x_handle", ""), "Required.");
  for (const ok of ["https://x.com/BlockulaChain/status/20", "https://twitter.com/BlockulaChain/status/20?s=20", "20"]) assert.equal(field("x_post", ok), null, ok);
  assert.equal(field("x_post", "https://example.com/a/status/20"), "That link isn't to x.com.");
  assert.match(field("x_post", "https://x.com/BlockulaChain"), /isn't to a post/);

  assert.equal(xRecordMemo("@BlockulaChain", "https://x.com/blockulachain/status/20?s=20"), "x-link:v1:BlockulaChain:20");
  assert.equal(xRecordMemo("BlockulaChain", "20"), "x-link:v1:BlockulaChain:20");
  assert.throws(() => xRecordMemo("BlockulaChain", "https://x.com/impostor/status/20"), /under @impostor, not @BlockulaChain/);
  assert.throws(() => xRecordMemo("BlockulaChain", "https://evil.example/BlockulaChain/status/20"), /x\.com/);
});

test("the record costs its fee and moves nothing", () => {
  const record = { from: ME, fee: "65180", nonce: 7, action: { type: "transfer", to: ME, amount: "0" } };
  const sender = { label: who(ME), balance: "1000000000", transferable: "1000000000", keys: [owner, agent], recent: [] };
  const p = preflight({ tx: record, sender, signer: "k-owner", head: 100, recipient: { label: who(ME), isNew: false } });
  assert.deepEqual(p.refusals, []);
  assert.equal(p.cost, 65180n);
  assert.equal(p.balanceAfter, 1000000000n - 65180n);
});
