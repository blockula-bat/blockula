// lib/multisig.ts: shared accounts (multisig) in the wallet. What a proposal does and what an
// approval binds are read from the action itself, never from the node's summary; a co-sign link
// picks a proposal and never describes it. Run with `npm test -w @blockula/web`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionDigest, encodeKeyGrant, Wallet } from "@blockula/sdk";
import { bech32m } from "@scure/base";
import {
  addOwnerSpec,
  agentBrief,
  asProposal,
  cosignLink,
  createWarnings,
  digestCheck,
  ownerKeyIds,
  proposable,
  proposalShare,
  readCosignLink,
  removeKeySpec,
  reviewHref,
  reviewPending,
  sharedHref,
  thresholdProblem,
  thresholdSpec,
} from "./multisig.ts";

const addr = (byte, prefix = "boo") => bech32m.encode(prefix, bech32m.toWords(new Uint8Array(32).fill(byte)));
const K1 = "a1".repeat(32);
const K2 = "b2".repeat(32);
const K3 = "c3".repeat(32);
const COVEN = addr(7);
const MINA = addr(9);
const pay = { type: "transfer", to: MINA, amount: "2000000000" };
const ms = (threshold = 2, owners = [K1, K2]) => ({ threshold, owners: owners.map((key_id, i) => ({ key_id, label: i ? "the other witch" : "original key" })) });
const pending = (o = {}) => ({ id: 0, action: pay, summary: "coven.boo proposed sending 2 FANG to mina.boo", approvals: [K1], valid_approvals: 1, expires_at: 700, expired: false, superseded: null, ...o });

test("a threshold is 1 to the number of owner keys", () => {
  assert.equal(thresholdProblem(1, 1), null);
  assert.equal(thresholdProblem(2, 3), null);
  assert.equal(thresholdProblem(3, 3), null);
  assert.match(thresholdProblem(0, 3), /1 to 3/);
  assert.match(thresholdProblem(4, 3), /1 to 3/);
  assert.match(thresholdProblem(1.5, 3), /1 to 3/);
  assert.match(thresholdProblem(2, 1), /can only be 1/);
  assert.match(thresholdProblem(1, 0), /no owner keys/);
  assert.match(thresholdProblem(2, 17), /at most 16/);
  // governance.rs: each owner key's share of the 32 open proposals, at least 1.
  assert.equal(proposalShare(2), 16);
  assert.equal(proposalShare(3), 10);
  assert.equal(proposalShare(16), 2);
});

test("only owner keys are a shared account's owners, lowercased", () => {
  assert.deepEqual(ownerKeyIds([{ key_id: K1.toUpperCase(), role: { type: "owner" } }, { key_id: K2, role: { type: "session" } }, { key_id: K3, role: { type: "owner" } }]), [K1, K3]);
});

test("the warning says what the chain's rules are", () => {
  const w = createWarnings(2, 3, { agents: 1, expiry: "7 days" }).join("\n");
  assert.match(w, /can't be undone/);
  assert.match(w, /No action turns a shared account back/);
  assert.match(w, /each recovery kit/);
  assert.match(w, /once 2 owner keys have approved it/);
  assert.match(w, /fewer than 2 remain, the account is locked for good/);
  assert.match(w, /you can lose 1 and still act/);
  assert.match(w, /about 7 days/);
  assert.match(w, /Up to 32 can be open at once, at most 10 from each owner key/);
  assert.match(w, /Your agent with a budget keeps sending within its limit/);
  // All must approve: losing one key locks it. One approval: any key acts alone.
  assert.match(createWarnings(3, 3).join("\n"), /If any one of them is lost, the account is locked for good/);
  assert.match(createWarnings(1, 3).join("\n"), /any one of the 3 owner keys acts alone: what it proposes runs at once/);
  assert.match(createWarnings(2, 2).join("\n"), /7 days by default/);
  // House rules: never "contracts".
  assert.doesNotMatch(w, /contract/i);
});

test("a proposal is read from its action, never from the node's summary", () => {
  const lying = pending({ summary: "coven.boo proposed renewing its name", valid_approvals: 2 });
  const r = reviewPending(lying, ms(), { myKeyId: K2, head: 100 });
  assert.match(r.does, /^Send 2 FANG to /);
  assert.ok(r.does.includes(MINA));
  assert.doesNotMatch(r.does, /renew/);
  assert.equal(r.digest, actionDigest(pay));
  // The approvals are counted here, from the owner keys: not the node's count.
  assert.equal(r.approvals, 1);
  assert.deepEqual(r.approvedBy, [K1]);
  assert.equal(r.iAmOwner, true);
  assert.equal(r.approvedByMe, false);
  assert.equal(r.wouldRun, true, "the second of two approvals runs it");
  assert.equal(r.approvable, true);
  assert.equal(r.why, null);
});

test("approvals from keys that aren't owners any more don't count", () => {
  const r = reviewPending(pending({ approvals: [K1, K3] }), ms(2, [K1, K2]), { myKeyId: K2 });
  assert.equal(r.approvals, 1);
  assert.deepEqual(r.strayApprovals, [K3]);
  const three = reviewPending(pending(), ms(3, [K1, K2, K3]), { myKeyId: K2 });
  assert.equal(three.wouldRun, false, "two of three approvals wait for the third");
  assert.equal(three.approvable, true);
});

test("what can't be approved says why, and offers no approval", () => {
  const mine = reviewPending(pending(), ms(), { myKeyId: K1 });
  assert.equal(mine.approvable, false);
  assert.match(mine.why, /already approved/);
  const stranger = reviewPending(pending(), ms(), { myKeyId: K3 });
  assert.equal(stranger.approvable, false);
  assert.match(stranger.why, /isn't one of the account's owner keys/);
  const expired = reviewPending(pending({ expired: true }), ms(), { myKeyId: K2 });
  assert.equal(expired.approvable, false);
  assert.match(expired.why, /expired/);
  // Past its expiry by the head, whatever the node's flag says.
  assert.equal(reviewPending(pending(), ms(), { myKeyId: K2, head: 701 }).expired, true);
  assert.equal(reviewPending(pending(), ms(), { myKeyId: K2, head: 700 }).expired, false);
  const superseded = reviewPending(pending({ superseded: "a cancellation withdrew it" }), ms(), { myKeyId: K2 });
  assert.equal(superseded.approvable, false);
  assert.equal(superseded.superseded, "a cancellation withdrew it");
  // An action this client can't read, or one no multisig holds (a program action).
  const odd = reviewPending(pending({ action: { type: "summon_bats" } }), ms(), { myKeyId: K2 });
  assert.equal(odd.readable, false);
  assert.equal(odd.approvable, false);
  assert.match(odd.why, /can't read all of it/);
  const rounded = reviewPending(pending({ action: { type: "transfer", to: MINA, amount: 2 ** 60 } }), ms(), { myKeyId: K2 });
  assert.equal(rounded.approvable, false);
  // A ballot without the proposal whose content it binds isn't approvable.
  const ballot = reviewPending(pending({ action: { type: "vote", proposal_id: 1, aye: true, amount: "5", conviction: 1, proposal_digest: "d1".repeat(32) } }), ms(), { myKeyId: K2 });
  assert.equal(ballot.approvable, false);
  // Without a key (locked), nothing is offered, and nothing is claimed either.
  const locked = reviewPending(pending(), ms());
  assert.equal(locked.approvable, false);
  assert.equal(locked.why, null);
});

test("a co-sign link names the account by address, the proposal and its digest", () => {
  const digest = actionDigest(pay);
  const link = cosignLink("https://node.example/wallet/", COVEN, 3, digest, { chainId: "blockula-dev", genesisHash: "ab".repeat(32) });
  const url = new URL(link);
  assert.equal(url.pathname, "/wallet/shared/review");
  assert.equal(url.searchParams.get("account"), COVEN);
  assert.equal(url.searchParams.get("id"), "3");
  assert.equal(url.searchParams.get("digest"), digest);
  assert.equal(url.searchParams.get("chain"), "blockula-dev");
  assert.equal(url.searchParams.get("genesis"), "ab".repeat(8));
  assert.deepEqual(readCosignLink(url.searchParams, "boo"), { ok: true, account: COVEN, id: 3, digest });
  // No digest, no chain: still a link, with nothing to check against.
  const bare = new URL(cosignLink("https://w.example", COVEN, 0, null));
  assert.equal(bare.search, `?account=${COVEN}&id=0`);
  assert.deepEqual(readCosignLink(bare.searchParams, "boo"), { ok: true, account: COVEN, id: 0, digest: null });
  assert.equal(new URL(cosignLink("https://w.example", COVEN, 0, "not-a-digest")).searchParams.get("digest"), null);
  assert.equal(sharedHref(COVEN), `/shared?account=${COVEN}`);
  assert.equal(sharedHref(), "/shared");
  assert.equal(reviewHref(COVEN, 2, digest), `/shared/review?account=${COVEN}&id=2&digest=${digest}`);
});

test("a link is anyone's text: only an address, a number and a digest are read from it", () => {
  const q = (o) => new URLSearchParams(o);
  assert.match(readCosignLink(q({}), "boo").problem, /doesn't say which/);
  assert.match(readCosignLink(q({ account: "coven.boo", id: "0" }), "boo").problem, /never by a name/);
  assert.match(readCosignLink(q({ account: addr(7, "tboo"), id: "0" }), "boo").problem, /isn't a boo1… address/);
  assert.match(readCosignLink(q({ account: COVEN, id: "1e3" }), "boo").problem, /proposal number/);
  assert.match(readCosignLink(q({ account: COVEN, id: "-1" }), "boo").problem, /proposal number/);
  assert.match(readCosignLink(q({ account: COVEN, id: "0", digest: "<script>" }), "boo").problem, /digest isn't one/);
  assert.equal(readCosignLink(q({ account: ` ${COVEN.toUpperCase()} `, id: "4", digest: "AB".repeat(32) }), "boo").digest, "ab".repeat(32));
});

test("the link's digest is a check on the stored action", () => {
  const digest = actionDigest(pay);
  assert.equal(digestCheck(digest, digest), "match");
  assert.equal(digestCheck(digest, actionDigest({ ...pay, amount: "2000000000000" })), "mismatch");
  assert.equal(digestCheck(digest, null), "mismatch", "an action whose digest can't be computed isn't the one linked");
  assert.equal(digestCheck(null, digest), "none");
});

const sendSpec = {
  kind: "transfer",
  title: "Send FANG",
  blurb: "",
  who: "any key",
  ownerOnly: false,
  params: [{ key: "to", label: "To", type: "account" }, { key: "amount", label: "Amount", type: "fang" }, { key: "memo", label: "Memo", type: "text", optional: true }],
  build: (v) => ({ type: "transfer", to: String(v.to), amount: String(v.amount) }),
  describe: (r) => `Send ${r.amount} FANG to ${r.to}`,
};

test("an action form's spec becomes a proposal of the same action", () => {
  const p = asProposal(sendSpec);
  assert.equal(p.kind, "multisig_propose");
  assert.equal(p.id, "propose:transfer");
  assert.equal(p.ownerOnly, true);
  assert.deepEqual(p.params.map((x) => x.key), ["to", "amount"], "the memo is the proposing tx's, not the action's");
  assert.deepEqual(p.build({ to: MINA, amount: "2000000000" }, { height: 1, account: COVEN }), { type: "multisig_propose", action: pay });
  assert.equal(p.describe({ to: "mina.boo", amount: "2" }), "Propose: Send 2 FANG to mina.boo");
  assert.equal(proposable(sendSpec), true);
  assert.equal(proposable({ ...sendSpec, kind: "multisig_propose" }), false, "proposals don't nest");
  assert.equal(proposable({ ...sendSpec, kind: "multisig_approve" }), false);
  assert.equal(proposable({ ...sendSpec, memo: () => "x-link:v1:…" }), false, "an action that is what its memo says");
});

test("changing the threshold proposes multisig_create with the owner keys as they are", () => {
  const spec = thresholdSpec([K1, K2, K3]);
  assert.deepEqual(spec.build({ threshold: 3 }, { height: 1, account: COVEN }), { type: "multisig_create", owners: [K1, K2, K3], threshold: 3 });
  assert.throws(() => spec.build({ threshold: 4 }, { height: 1, account: COVEN }), /1 to 3/);
  assert.throws(() => spec.build({ threshold: 0 }, { height: 1, account: COVEN }), /1 to 3/);
  assert.equal(spec.describe({ threshold: "2" }), "Make this a 2-of-3 shared account");
});

test("adding an owner takes the key's own grant, made for this account", async () => {
  const chain = { chainId: "blockula-dev", genesisHash: "ab".repeat(32) };
  const agent = Wallet.generate();
  const grant = await agent.keyGrant(COVEN, chain);
  const action = addOwnerSpec(COVEN).build({ grant: encodeKeyGrant(grant), label: "claude" }, { height: 1, account: COVEN });
  assert.deepEqual(action, { type: "add_key", key_id: agent.keyId, label: "claude", role: { type: "owner" }, public_key: grant.public_key, pop: grant.pop });
  // A grant made for another account, and a bare key id, are refused before anything is built.
  const other = encodeKeyGrant(await agent.keyGrant(MINA, chain));
  assert.throws(() => addOwnerSpec(COVEN).build({ grant: other, label: "claude" }, { height: 1, account: COVEN }), /for another account/);
  assert.throws(() => addOwnerSpec(COVEN).build({ grant: agent.keyId, label: "claude" }, { height: 1, account: COVEN }), /grant code/);
  assert.deepEqual(removeKeySpec().build({ key_id: K2.toUpperCase() }, { height: 1, account: COVEN }), { type: "remove_key", key_id: K2 });
  assert.throws(() => removeKeySpec().build({ key_id: "abc" }, { height: 1, account: COVEN }), /64 characters/);
});

test("the agent's brief names the account by address and the tools it uses", () => {
  const brief = agentBrief(COVEN, "2-of-3 multisig");
  assert.ok(brief.includes(`use_account with account "${COVEN}"`));
  for (const tool of ["multisig_show", "multisig_propose_send", "multisig_approve", "wallet.multisigPropose", "wallet.multisigApprove"]) assert.ok(brief.includes(tool), tool);
});
