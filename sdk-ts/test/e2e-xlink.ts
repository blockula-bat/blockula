// End to end against a running node (`blockula dev`, or BLOCKULA_RPC): X account linking
// (src/xlink.ts, docs/X-LINKING.md) on a real chain. The chain takes the record (a transfer of 0
// from the account to itself, memo and all), shows who signed it, and `client.xLink` reads it
// back; a session key's record and a payment from someone else are ignored; unlinking ends it.
// X is a stand-in here (`endpoint`): nothing leaves this machine. `npm test -w @blockula/sdk`
// runs it after e2e-integrators.ts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client, Wallet, verifyXLink, xLinkCode, xLinkMemo, xPostRef } from "../src/index.js";

const RPC = process.env.BLOCKULA_RPC ?? "http://localhost:7070";
const client = new Client(RPC, { network: "local" });
const status = await client.status();

const me = Wallet.generate(client);
await me.faucet();
assert.equal(await client.xLink(me.account), null);

// A stand-in for X's oEmbed endpoint: post 20 is by @BlockulaChain and holds whatever `posted` is.
let posted = "";
const x = createServer((req, res) => {
  const id = xPostRef(new URL(req.url ?? "", "http://x").searchParams.get("url") ?? "").id;
  if (id !== "20") return void res.writeHead(404).end("<html></html>");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: "https://x.com/BlockulaChain/status/20", author_url: "https://x.com/BlockulaChain", html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${posted.replace(/\n/g, "<br>")}</p>&mdash; Blockula (@BlockulaChain)</blockquote>` }));
});
await new Promise<void>((done) => x.listen(0, "127.0.0.1", done));
const endpoint = `http://127.0.0.1:${(x.address() as { port: number }).port}/oembed`;

try {
  // 1. The proof: a code for this chain, this account and this handle.
  const proof = await me.xProof("@BlockulaChain");
  assert.equal(proof.code, xLinkCode({ chainId: status.chain_id, genesisHash: status.genesis_hash }, me.account, "BlockulaChain"));
  posted = proof.text;

  // 2. The record.
  const before = await me.balances();
  const tx = await me.linkX("BlockulaChain", "https://x.com/BlockulaChain/status/20");
  assert.equal(tx.status, "finalized");
  assert.equal(tx.memo, "x-link:v1:BlockulaChain:20");
  assert.equal(tx.signer_key, me.keyId);
  assert.equal(tx.to.address, me.account);
  const after = await me.balances();
  assert.equal(before.balance - after.balance, BigInt(tx.fee), "the record costs its fee and moves nothing else");
  console.log("✓", tx.summary, `(memo ${tx.memo}, fee ${tx.fee_display})`);

  // 3. Anyone reads it and checks the post.
  const link = await client.xLink(me.account);
  assert.deepEqual(link && [link.handle, link.post_id, link.code, link.tx, link.signer], ["BlockulaChain", "20", proof.code, tx.id, me.keyId]);
  assert.deepEqual(await verifyXLink(link!, { endpoint }), { verified: true, reason: `@BlockulaChain posted ${proof.code}`, post: { id: "20", handle: "BlockulaChain", untrusted_text: proof.text } });
  console.log("✓ the link reads back and verifies against the post");

  // Someone else can't make the record: their payment to the account with the same memo isn't one,
  // and their own record for the same post doesn't verify (the code is this account's).
  const other = Wallet.generate(client);
  await other.faucet();
  await other.send(me.account, "1", { memo: xLinkMemo("impostor", "20") });
  assert.equal((await client.xLink(me.account))?.handle, "BlockulaChain");
  await other.linkX("BlockulaChain", "20");
  const stolen = await client.xLink(other.account);
  assert.equal(stolen?.post_id, "20");
  assert.equal((await verifyXLink(stolen!, { endpoint })).verified, false);
  console.log("✓ a payment with the memo isn't a record, and another account's record for the post doesn't verify");

  // A session key (an agent's budget) can send transfers, so it can send this one: it isn't a record.
  const agent = Wallet.generate(client);
  const height = (await client.status()).height;
  await me.addSessionKey(await agent.keyGrant(me.account), "agent", { limit: "5", periodBlocks: 1000, expiresInBlocks: 5000 });
  await agent.actAs(me.account);
  await assert.rejects(agent.linkX("agent_handle", "20"), /only an owner key can link an X account/);
  const sneaky = await client.submit(await agent.build({ type: "transfer", to: me.account, amount: "0" }, xLinkMemo("agent_handle", "20")));
  assert.equal(sneaky.status, "finalized", `the chain takes it (signed at height ${height}): readers don't`);
  assert.equal((await client.xLink(me.account))?.handle, "BlockulaChain");
  console.log("✓ a session key's record is ignored");

  // 4. Unlink, and link again.
  await me.unlinkX();
  assert.equal(await client.xLink(me.account), null);
  await me.linkX("BlockulaChain", "20");
  assert.equal((await client.xLink(me.account))?.post_id, "20");
  // The post is deleted: the record stays, and no longer verifies.
  posted = "";
  assert.equal((await verifyXLink((await client.xLink(me.account))!, { endpoint })).verified, false);
  console.log("✓ unlinking ends the link; a deleted proof no longer verifies");
} finally {
  x.close();
}

console.log("\n🧛 X linking e2e: all checks passed");
