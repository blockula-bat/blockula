// Shared accounts (multisig) in the wallet: making an account shared with a co-owner's key (a
// person's, or an agent's) after the chain's rules are spelled out; proposing an action; and
// reviewing a co-owner's proposal from its co-sign link, rendered from the action itself (never
// the node's summary), with an approval that binds that action's digest. The mock node checks
// every transaction the way the chain does (e2e/mock-node.ts).
import { actionDigest, decodeKeyGrant, encodeKeyGrant, parseFang, verifyKeyGrant, Wallet, type Action, type Tx } from "@blockula/sdk";
import type { Page } from "@playwright/test";
import { CHAIN_ID, GENESIS } from "./env";
import { createWallet, cspViolations, expect, test, watchCsp } from "./helpers";
import { addressOf, type MockNode } from "./mock-node";

const actionOf = (tx: Tx | undefined) => tx?.action as Record<string, unknown> | undefined;
const MINA = addressOf("9a".repeat(32));
const pay = (fang: string): Action => ({ type: "transfer", to: MINA, amount: parseFang(fang).toString() });

/** A page opened by its URL starts locked: unlock it with the passkey. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole("button", { name: "Unlock with passkey" }).click();
}

/** Makes `account` a `threshold`-of-N multisig on the mock node, with `others` as owner keys beside its own. */
function share(node: MockNode, account: string, others: { keyId: string; label: string }[], threshold: number) {
  const keys = new Map(node.keysOf(account));
  for (const o of others) keys.set(o.keyId, { label: o.label, role: { type: "owner" }, added_at: 1 });
  node.acct(account).keys = keys;
  const owners = [...keys].filter(([, k]) => k.role.type === "owner").map(([key_id, k]) => ({ key_id, label: k.label }));
  const ms = { account: node.label(account), threshold, owners, created_at: 1, pending: [] as Record<string, unknown>[] };
  node.multisigs.set(account, ms);
  return ms;
}

/** A proposal waiting on `account`, proposed and approved by `by`. */
const proposal = (id: number, action: Action, by: string, summary: string) => ({ id, action, summary, proposed_by: by, approvals: [by], valid_approvals: 1, created_at: 90, expires_at: 604_890, expired: false, superseded: null });

const cosign = (account: string, id: number, digest: string) => `/shared/review?account=${account}&id=${id}&digest=${digest}&chain=${CHAIN_ID}&genesis=${GENESIS.slice(0, 16)}`;

test("makes an account shared with an agent's key, after the chain's rules are spelled out", async ({ page, node }) => {
  await watchCsp(page);
  const created = await createWallet(page);
  await page.getByRole("link", { name: "Shared", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shared accounts" })).toBeVisible();
  const make = page.getByTestId("make-shared");
  await expect(make.getByTestId("owner-key")).toHaveCount(1);
  // One owner key: nobody to share it with yet.
  await expect(make.getByTestId("needs-coowner")).toBeVisible();
  await expect(page.getByTestId("my-key-id")).toHaveText(created.keyId);

  // A bare key id can't be added: a key joins only with its own consent, its grant code.
  const agent = Wallet.generate();
  const code = make.getByPlaceholder("bkgrant1.…");
  await code.fill(agent.keyId);
  await expect(make.getByText(/grant code/).last()).toBeVisible();
  await expect(make.getByRole("button", { name: "Add as an owner" })).toBeDisabled();
  await expect(make.getByTestId("coowner-warning")).toContainText("full control");
  await code.fill(encodeKeyGrant(await agent.keyGrant(created.account, { chainId: CHAIN_ID, genesisHash: GENESIS })));
  await expect(make.getByTestId("coowner-check")).toContainText("Check code:");
  await make.getByPlaceholder("Mina, or claude").fill("claude");
  await make.getByRole("button", { name: "Add as an owner" }).click();
  await expect(make.getByTestId("owner-key")).toHaveCount(2);
  expect(actionOf(node.submitted.at(-1))).toMatchObject({ type: "add_key", key_id: agent.keyId, label: "claude", role: { type: "owner" } });

  // The threshold is 1 to the number of owner keys; the warning is the chain's rules, and nothing is signed before the box is ticked.
  await expect(make.getByTestId("threshold").locator("option")).toHaveText(["1 of 2", "2 of 2"]);
  await expect(make.getByTestId("threshold")).toHaveValue("2");
  const warning = make.getByTestId("shared-warning");
  await expect(warning).toContainText("This can't be undone");
  await expect(warning).toContainText("an owner key can only propose an action and approve one");
  await expect(warning).toContainText("All 2 owner keys must approve everything. If any one of them is lost, the account is locked for good");
  await expect(warning).toContainText("A proposal waits about 7 days");
  await make.getByTestId("threshold").selectOption("1");
  await expect(warning).toContainText("any one of the 2 owner keys acts alone");
  await make.getByTestId("threshold").selectOption("2");
  await expect(make.getByTestId("shared-signs")).toHaveText(`Make the account a 2-of-2 multisig of the owner keys ${created.keyId.slice(0, 12)}…${created.keyId.slice(-8)}, ${agent.keyId.slice(0, 12)}…${agent.keyId.slice(-8)}`);
  const go = make.getByRole("button", { name: "Make it a 2-of-2 shared account" });
  await expect(go).toBeDisabled();
  const before = node.submitted.length;
  await make.getByTestId("understood").check();
  await go.click();

  await expect(page.getByTestId("shared-shape")).toHaveText("2-of-2 multisig");
  expect(node.submitted).toHaveLength(before + 1);
  expect(actionOf(node.submitted.at(-1))).toEqual({ type: "multisig_create", owners: [created.keyId, agent.keyId], threshold: 2 });
  await expect(page.getByTestId("shared-rule")).toHaveText("Both owners must approve every action.");
  await expect(page.getByTestId("shared-owner")).toHaveCount(2);
  await expect(page.getByTestId("shared-owner").filter({ hasText: "claude" })).toBeVisible();
  // What to tell the agent names the account by its address and the MCP's tools.
  await expect(page.getByTestId("shared-agent-brief")).toContainText(`use_account with account "${created.account}"`);
  // Home says what the account is now, since Send no longer works for its owner keys.
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByTestId("shared-banner")).toContainText("This is a 2-of-2 shared account.");
  expect(await cspViolations(page)).toEqual([]);
});

test("proposes a payment from a shared account, and its co-sign link carries the action's digest", async ({ page, node }) => {
  const created = await createWallet(page);
  const agent = Wallet.generate();
  share(node, created.account, [{ keyId: agent.keyId, label: "claude" }], 2);
  await page.getByRole("link", { name: "Shared", exact: true }).click();
  await expect(page.getByTestId("shared-shape")).toHaveText("2-of-2 multisig");
  await expect(page.getByText("Nothing is waiting for approval.")).toBeVisible();

  const form = page.getByTestId("shared-propose");
  await expect(form).toContainText("It runs, as the account, once one more owner key approves it.");
  await expect(form.getByLabel("Action to propose")).toHaveValue("transfer");
  await form.getByLabel("To", { exact: true }).fill(MINA);
  await form.getByLabel("Amount", { exact: true }).fill("2");
  await form.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = form.getByTestId("action-preview");
  // The proposal is described from the action it wraps, and a multisig's owner key may sign it.
  await expect(preview.getByTestId("signs")).toHaveText(`Propose a multisig action: Send 2 FANG to ${MINA}`);
  await expect(preview).not.toContainText("its owner keys can only propose");
  const before = node.submitted.length;
  await preview.getByRole("button", { name: "Sign & send" }).click();
  await expect(page).toHaveURL(/\/tx\//);
  expect(node.submitted).toHaveLength(before + 1);
  expect(actionOf(node.submitted.at(-1))).toEqual({ type: "multisig_propose", action: pay("2") });
  expect(node.submitted.at(-1)?.from).toBe(created.account);
  // Nothing moved: it waits for the co-owner.
  expect(node.acct(MINA).balance).toBe(0n);

  // The receipt leads back to the shared account, where the proposal waits with its link.
  await page.getByRole("link", { name: /^Open the shared account/ }).click();
  const row = page.getByTestId("shared-proposal");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("shared-does")).toHaveText(`Send 2 FANG to ${MINA}`);
  await expect(row.getByTestId("shared-approvals")).toHaveText("1 of 2 approvals");
  await expect(row).toContainText("you approved it");
  const id = (node.multisigs.get(created.account) as { pending: { id: number }[] }).pending[0].id;
  await expect(row.getByRole("link", { name: "Review", exact: true })).toHaveAttribute("href", new RegExp(`/shared/review/?\\?account=${created.account}&id=${id}&digest=${actionDigest(pay("2"))}$`));

  // An owner key can't send directly any more: the chain refuses it, and the preflight says so first.
  await page.goto("/programs/accounts");
  await page.locator("summary", { hasText: "Send FANG" }).click();
  const send = page.locator("details.action[open]");
  await send.getByRole("button", { name: "Unlock to sign" }).click();
  await send.getByLabel("To", { exact: true }).fill(MINA);
  await send.getByLabel("Amount", { exact: true }).fill("1");
  await send.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(send.getByTestId("action-preview")).toContainText("its owner keys can only propose an action");
});

test("reviews a co-owner's proposal from its link and approves it: the action, not the node's words", async ({ page, node }) => {
  await watchCsp(page);
  const created = await createWallet(page);
  const agent = Wallet.generate();
  const ms = share(node, created.account, [{ keyId: agent.keyId, label: "claude" }], 2);
  // The agent proposed paying mina 2 FANG. The node's summary of it lies.
  ms.pending.push(proposal(4, pay("2"), agent.keyId, "claude proposed renewing a name for 1 FANG"));
  const digest = actionDigest(pay("2"));
  const had = node.acct(created.account).balance;

  await open(page, cosign(created.account, 4, digest));
  const review = page.getByTestId("review");
  await expect(review.getByTestId("review-does")).toHaveText(`Send 2 FANG to ${MINA}`);
  await expect(review).not.toContainText("renewing a name");
  await expect(review.getByTestId("review-match")).toBeVisible();
  await expect(review.getByTestId("review-digest")).toHaveText(digest);
  await expect(review.getByTestId("review-approvals")).toHaveText("1 of 2 approvals");
  await expect(review.getByTestId("review-by")).toHaveText("claude");
  await expect(review.getByTestId("review-effect")).toContainText("Yours is approval 2 of 2: the chain runs the action at once, as the account.");
  const before = node.submitted.length;
  await review.getByRole("button", { name: "Approve and run it" }).click();

  const approved = page.getByTestId("approved");
  await expect(approved.getByRole("heading")).toHaveText("Approved, and it ran");
  expect(node.submitted).toHaveLength(before + 1);
  // The approval binds the digest of the action this wallet rendered.
  expect(actionOf(node.submitted.at(-1))).toEqual({ type: "multisig_approve", id: 4, action_digest: digest });
  expect(node.submitted.at(-1)?.from).toBe(created.account);
  // It reached the threshold, so the chain ran the payment as the account.
  expect(node.acct(MINA).balance).toBe(parseFang("2"));
  expect(node.acct(created.account).balance).toBeLessThan(had - parseFang("2") + 1n);
  expect((node.multisigs.get(created.account) as { pending: unknown[] }).pending).toHaveLength(0);
  expect(await cspViolations(page)).toEqual([]);
});

test("won't approve an action that isn't the one the link was made for", async ({ page, node }) => {
  const created = await createWallet(page);
  const agent = Wallet.generate();
  const ms = share(node, created.account, [{ keyId: agent.keyId, label: "claude" }], 2);
  // The sender saw 2 FANG to mina; the node now shows 2,000 under the same number.
  ms.pending.push(proposal(4, pay("2000"), agent.keyId, "claude proposed sending 2 FANG to mina"));
  await open(page, cosign(created.account, 4, actionDigest(pay("2"))));
  const review = page.getByTestId("review");
  await expect(review.getByTestId("review-does")).toHaveText(`Send 2,000 FANG to ${MINA}`);
  await expect(review.getByTestId("review-mismatch")).toContainText("This isn't the action the link was made for");
  await expect(review.getByRole("button", { name: /^Approve/ })).toHaveCount(0);

  // A link that isn't one says so, and reads nothing from the node for it.
  await open(page, `/shared/review?account=coven.boo&id=4`);
  await expect(page.getByTestId("review-problem")).toContainText("never by a name");
  await open(page, `/shared/review?account=${created.account}&id=4&chain=blockula-elsewhere`);
  await expect(page.getByTestId("review-problem")).toContainText("another network");
  // A proposal that already ran or expired isn't there to approve.
  await open(page, cosign(created.account, 9, actionDigest(pay("2"))));
  await expect(page.getByTestId("review-missing")).toContainText("no open proposal #9");
  expect(node.submitted.some((t) => t.action.type === "multisig_approve")).toBe(false);
});

test("a key that co-owns another account switches to it to approve; one that doesn't can only read", async ({ page, node }) => {
  const created = await createWallet(page);
  // Another person's account, which this device's key joined as an owner: a 2-of-2 with a payment waiting.
  const theirs = Wallet.generate();
  const coven = addressOf(theirs.keyId);
  node.credit(coven, "50");
  const ms = share(node, coven, [{ keyId: created.keyId, label: "Vlad's laptop" }], 2);
  ms.pending.push(proposal(0, pay("5"), theirs.keyId, "coven proposed sending 5 FANG"));
  const digest = actionDigest(pay("5"));

  await open(page, cosign(coven, 0, digest));
  // The wallet still acts for its own account: it offers to switch, since the key is an owner there.
  const other = page.getByTestId("other-account");
  await expect(other).toContainText("This device's key is one of that account's owner keys (“Vlad's laptop”)");
  const review = page.getByTestId("review");
  await expect(review.getByTestId("review-does")).toHaveText(`Send 5 FANG to ${MINA}`);
  await expect(review.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await other.getByRole("button", { name: "Switch to that account" }).click();
  await expect(page.getByTestId("other-account")).toHaveCount(0);
  await review.getByRole("button", { name: "Approve and run it" }).click();
  await expect(page.getByTestId("approved")).toBeVisible();
  expect(actionOf(node.submitted.at(-1))).toEqual({ type: "multisig_approve", id: 0, action_digest: digest });
  expect(node.submitted.at(-1)?.from).toBe(coven);
  expect(node.acct(MINA).balance).toBe(parseFang("5"));

  // Its own account is listed to switch back to.
  await page.getByRole("link", { name: "Back to the shared account" }).click();
  await expect(page.getByTestId("shared-shape")).toHaveText("2-of-2 multisig");
  await expect(page.getByTestId("co-owned-row").filter({ hasText: created.account })).toBeVisible();

  // A shared account this key isn't on: readable, with no approval offered.
  const stranger = Wallet.generate();
  const elsewhere = addressOf(stranger.keyId);
  const sm = share(node, elsewhere, [{ keyId: "c3".repeat(32), label: "another" }], 2);
  sm.pending.push(proposal(7, pay("1"), stranger.keyId, "x"));
  await open(page, cosign(elsewhere, 7, actionDigest(pay("1"))));
  await expect(page.getByTestId("other-account")).toContainText("This device's key isn't on that account");
  await expect(page.getByTestId("review").getByTestId("review-does")).toHaveText(`Send 1 FANG to ${MINA}`);
  await expect(page.getByTestId("review").getByRole("button", { name: /^Approve/ })).toHaveCount(0);
});

test("joining someone's shared account makes this key's grant code for it", async ({ page }) => {
  const created = await createWallet(page);
  await page.getByRole("link", { name: "Shared", exact: true }).click();
  const join = page.getByTestId("your-key");
  const theirs = addressOf("5e".repeat(32));
  await join.getByLabel("The shared account's address").fill("coven.boo");
  await expect(join).toContainText("not a name");
  await expect(join.getByRole("button", { name: "Make my grant code" })).toBeDisabled();
  await join.getByLabel("The shared account's address").fill(theirs);
  await join.getByRole("button", { name: "Make my grant code" }).click();
  const grant = join.getByTestId("join-grant");
  await expect(grant.locator("pre")).toHaveText(/^bkgrant1\./);
  await expect(grant).toContainText("It holds no secret");
  // The code is this key's consent to that account, and to no other.
  const g = decodeKeyGrant((await grant.locator("pre").textContent()) ?? "");
  expect(g.account).toBe(theirs);
  expect(g.key_id).toBe(created.keyId);
  expect(verifyKeyGrant(g, CHAIN_ID, GENESIS)).toBe(true);
});
