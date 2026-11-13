/**
 * Shared accounts (multisig, docs/GOVERNANCE.md "Multisig accounts"): an account whose owner keys,
 * a person's passkeys and an agent's key alike, act together. Everything here is read from the
 * action itself, the content an approval binds by its digest (`actionDigest`), never from the
 * node's `summary` of it, which no digest covers (audit gap-7-6).
 *
 * Pure (the SDK, and type imports), so `node --test` runs it directly (lib/multisig.test.mjs).
 */
import { actionDigest, decodeKeyGrant, isAddress, reviewAction, type Action } from "@blockula/sdk";
import type { ActionSpec } from "./explorer/programs";
import type { MultisigView } from "./explorer/types";
import { CHAIN_ID, GENESIS_HEX, type WalletChain } from "./paylink.ts";

/** Most owner keys a shared account can list (the SDK's `multisigCreate`, the chain's key limit). */
export const MAX_OWNERS = 16;
/** Most open proposals one shared account holds (node/src/governance.rs `MAX_MULTISIG_PENDING`). */
export const MAX_PENDING = 32;

const KEY_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** Why `threshold` can't be this account's, or null: the chain takes 1 to the number of owner keys. */
export function thresholdProblem(threshold: number, owners: number): string | null {
  if (owners < 1) return "The account has no owner keys.";
  if (owners > MAX_OWNERS) return `A shared account has at most ${MAX_OWNERS} owner keys; this one has ${owners}.`;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners) return owners === 1 ? "With one owner key the threshold can only be 1." : `Choose 1 to ${owners}: the number of owner keys that must approve.`;
  return null;
}

/** Each owner key's most open proposals at once (governance.rs: its share of 32, at least 1). */
export const proposalShare = (owners: number) => Math.max(1, Math.floor(MAX_PENDING / Math.max(1, owners)));

/**
 * What making an account shared means, as the chain's rules have it (node/src/governance.rs
 * `multisig_create`, `check_multisig_admission`, `multisig_propose`, `run_multisig`). Shown
 * before the owner signs; `expiry` is how long a proposal waits ("7 days"), when the node said.
 */
export function createWarnings(threshold: number, owners: number, opts: { agents?: number; expiry?: string } = {}): string[] {
  const m = threshold;
  const out = [
    "This can't be undone. No action turns a shared account back into an ordinary one. The owners can change the threshold later, by proposing it and approving it together, but owner keys act through proposals from now on.",
    `Every owner key counts: each device, each recovery kit and each co-owner's key. After this, an owner key can only propose an action and approve one. Sending, staking, voting, names, adding or revoking keys: each runs once ${m === 1 ? "one owner key has" : `${m} owner keys have`} approved it. This wallet's own Send, Stake and Governance pages stop working for this account; propose those actions from Shared accounts.`,
  ];
  if (m === 1) out.push(`With a threshold of 1, any one of the ${owners} owner keys acts alone: what it proposes runs at once.`);
  else if (m >= owners) out.push(`All ${owners} owner keys must approve everything. If any one of them is lost, the account is locked for good: nothing can replace a key without all ${owners} approvals.`);
  else out.push(`If owner keys are lost and fewer than ${m} remain, the account is locked for good. With ${owners} owner keys you can lose ${owners - m} and still act.`);
  out.push(`A proposal waits ${opts.expiry ? `about ${opts.expiry}` : "a limited time (7 days by default)"} for its approvals, then expires. Up to ${MAX_PENDING} can be open at once, at most ${proposalShare(owners)} from each owner key.`);
  out.push("The owner keys can't drop below the threshold: a proposal that would remove one too many fails.");
  out.push(opts.agents ? `Your ${opts.agents === 1 ? "agent with a budget keeps" : `${opts.agents} agents with a budget keep`} sending within ${opts.agents === 1 ? "its limit" : "their limits"}, without approvals.` : "Agents with a budget (session keys) keep sending within their limits, without approvals.");
  return out;
}

/** The owner key ids `multisig_create` must list: exactly the account's owner keys, or why it can't. */
export function ownerKeyIds(keys: { key_id: string; role: { type: string } }[]): string[] {
  return keys.filter((k) => k.role.type === "owner").map((k) => k.key_id.toLowerCase());
}

type Pending = MultisigView["pending"][number];

/** A pending proposal as an owner should see it before approving. */
export interface PendingReview {
  id: number;
  /** What it does, rendered here from the action (`reviewAction`). */
  does: string;
  /** Whether this wallet could read all of it. */
  readable: boolean;
  /** `actionDigest(action)`: what an approval binds. Null when the action can't be encoded. */
  digest: string | null;
  /** Approvals that are still owner keys, counted here (not the node's count). */
  approvals: number;
  threshold: number;
  /** The approving key ids that are owner keys, and those that no longer are. */
  approvedBy: string[];
  strayApprovals: string[];
  /** Whether `myKeyId` is among the approvals. */
  approvedByMe: boolean;
  /** Whether `myKeyId` is one of the account's owner keys. */
  iAmOwner: boolean;
  expiresAt: number;
  expired: boolean;
  /** The node's reason no approval can file it any more (its words), or null. */
  superseded: string | null;
  /** Whether this approval would bring it to the threshold, and so run it. */
  wouldRun: boolean;
  /** Whether to offer an approval at all, and if not, why (ours, in words). */
  approvable: boolean;
  why: string | null;
}

/**
 * Reads one pending proposal for review. `proposal`: for a `vote` action, the node's read of the
 * governance proposal it names; a ballot is readable only when that content hashes to the digest
 * it binds. `head`: the node's height, so a proposal past its expiry reads as expired even when
 * the node's flag says otherwise.
 */
export function reviewPending(p: Pending, ms: Pick<MultisigView, "threshold" | "owners">, opts: { proposal?: unknown; head?: number; myKeyId?: string } = {}): PendingReview {
  const action = p.action as Record<string, unknown> | undefined;
  const review = reviewAction(action, action?.type === "vote" ? { proposal: opts.proposal } : {});
  let digest: string | null = null;
  try {
    digest = actionDigest(action as unknown as Action);
  } catch {
    digest = null;
  }
  const owners = new Set(ms.owners.map((o) => o.key_id));
  const all = Array.isArray(p.approvals) ? p.approvals.filter((k): k is string => typeof k === "string") : [];
  const approvedBy = all.filter((k) => owners.has(k));
  const me = opts.myKeyId;
  const iAmOwner = !!me && owners.has(me);
  const approvedByMe = !!me && all.includes(me);
  const expired = p.expired === true || (opts.head != null && Number.isSafeInteger(p.expires_at) && opts.head > p.expires_at);
  const superseded = typeof p.superseded === "string" && p.superseded ? p.superseded : null;
  const why = !review.readable
    ? "This wallet can't read all of it, so it won't sign an approval."
    : !digest
      ? "This wallet can't compute what an approval would bind, so it won't sign one."
      : expired
        ? "It expired: no approval counts any more."
        : superseded
          ? "No approval can file it any more."
          : !me
            ? null
            : !iAmOwner
              ? "This device's key isn't one of the account's owner keys."
              : approvedByMe
                ? "This device's key already approved it."
                : null;
  return {
    id: p.id,
    does: review.does,
    readable: review.readable,
    digest,
    approvals: approvedBy.length,
    threshold: ms.threshold,
    approvedBy,
    strayApprovals: all.filter((k) => !owners.has(k)),
    approvedByMe,
    iAmOwner,
    expiresAt: p.expires_at,
    expired,
    superseded,
    wouldRun: iAmOwner && !approvedByMe && approvedBy.length + 1 >= ms.threshold,
    approvable: why === null && !!me,
    why,
  };
}

/**
 * Co-sign links: `<wallet>/shared/review?account=<address>&id=<n>&digest=<hex>&chain=<chain id>&genesis=<hex>`.
 * One owner (a person, or an agent's `multisig_show`) hands it to another, who opens the review
 * page on the proposal. A link is anyone's text: it picks which proposal to look at, never what
 * it says. The page renders the stored action itself, and `digest` is a check only: when the
 * stored action's digest isn't the link's, the proposal isn't the one the sender saw, and the
 * page refuses to approve it. Always the account's address, never a name (a name is a node's
 * word). `chain` and `genesis` are a payment link's check (lib/paylink.ts).
 */
export function cosignLink(walletUrl: string, account: string, id: number, digest?: string | null, chain?: WalletChain): string {
  const q = new URLSearchParams({ account, id: String(id) });
  if (digest && DIGEST.test(digest)) q.set("digest", digest);
  if (chain?.chainId && CHAIN_ID.test(chain.chainId)) {
    q.set("chain", chain.chainId);
    if (chain.genesisHash && /^[0-9a-f]{64}$/i.test(chain.genesisHash)) q.set("genesis", chain.genesisHash.slice(0, GENESIS_HEX).toLowerCase());
  }
  return `${walletUrl.replace(/\/$/, "")}/shared/review?${q}`;
}

/** The shared account's own page for another owner: `<wallet>/shared?account=<address>`. */
export const sharedHref = (account?: string) => (account ? `/shared?account=${encodeURIComponent(account)}` : "/shared");
export const reviewHref = (account: string, id: number, digest?: string | null) => `/shared/review?account=${encodeURIComponent(account)}&id=${id}${digest ? `&digest=${digest}` : ""}`;

export type CosignRef = { ok: true; account: string; id: number; digest: string | null } | { ok: false; problem: string };

/** What a co-sign link asks to review, checked before anything reads or shows it. `prefix`: the chain's address prefix. */
export function readCosignLink(params: { get(key: string): string | null }, prefix: string): CosignRef {
  const account = params.get("account")?.trim().toLowerCase() ?? "";
  const id = params.get("id")?.trim() ?? "";
  const digest = params.get("digest")?.trim().toLowerCase() ?? "";
  if (!account || !id) return { ok: false, problem: "This link doesn't say which shared account and proposal it's about." };
  if (!isAddress(account, prefix)) return { ok: false, problem: `This link's account isn't a ${prefix}1… address. A co-sign link names the shared account by its address, never by a name.` };
  if (!/^\d{1,15}$/.test(id)) return { ok: false, problem: "This link's proposal number isn't one." };
  if (digest && !DIGEST.test(digest)) return { ok: false, problem: "This link's digest isn't one (64 characters of 0–9 and a–f)." };
  return { ok: true, account, id: Number(id), digest: digest || null };
}

/** Whether the stored action is the one a link's sender saw: `none` when the link carries no digest. */
export function digestCheck(linked: string | null, digest: string | null): "match" | "mismatch" | "none" {
  if (!linked) return "none";
  return digest !== null && linked === digest ? "match" : "mismatch";
}

/**
 * An action form's spec, proposed for a shared account instead of sent: the same typed fields and
 * checks, with the action wrapped in `multisig_propose`. The form's preview then shows the
 * proposal the owner signs, described from the action itself.
 */
export function asProposal(spec: ActionSpec): ActionSpec {
  return {
    ...spec,
    id: `propose:${spec.id ?? spec.kind}`,
    kind: "multisig_propose",
    who: "the shared account's owner keys",
    ownerOnly: true,
    // A proposal's memo is the proposing transaction's, not the action's: it says nothing the action runs with.
    params: spec.params.filter((p) => p.key !== "memo"),
    memo: undefined,
    build: (v, ctx) => ({ type: "multisig_propose", action: spec.build(v, ctx) }),
    describe: (raw) => `Propose: ${spec.describe(raw)}`,
  };
}

/**
 * Whether a spec's action can be proposed from the form: not a multisig proposal or approval
 * (they don't nest), and not an action that is what its memo says (an X link's record: the memo
 * that runs is the proposing transaction's, so those are made with the SDK).
 */
export const proposable = (spec: ActionSpec) => spec.kind !== "multisig_propose" && spec.kind !== "multisig_approve" && !spec.memo;

/** Change the threshold: a shared account proposes `multisig_create` again, listing its owner keys as they are. */
export function thresholdSpec(owners: string[]): ActionSpec {
  return {
    id: "multisig_threshold",
    kind: "multisig_create",
    title: "Change the threshold",
    blurb: `How many of the account's ${owners.length} owner keys must approve an action. It changes once enough of them approve this proposal, at the threshold in force now.`,
    who: "the shared account's owner keys",
    ownerOnly: true,
    params: [{ key: "threshold", label: "New threshold", type: "int", placeholder: `1 to ${owners.length}`, help: `1 to ${owners.length}` }],
    build: (v) => {
      const threshold = Number(v.threshold);
      const problem = thresholdProblem(threshold, owners.length);
      if (problem) throw new Error(problem);
      return { type: "multisig_create", owners, threshold };
    },
    describe: (r) => `Make this a ${r.threshold || "…"}-of-${owners.length} shared account`,
  };
}

/**
 * Add an owner: the new key's grant code (its consent to this account, which the chain requires)
 * becomes an `add_key` action. `account`: the shared account the grant must be for.
 */
export function addOwnerSpec(account: string): ActionSpec {
  return {
    id: "add_owner",
    kind: "add_key",
    title: "Add an owner",
    blurb: "Add a person's or an agent's key as an owner. Its holder makes a grant code for this account (Shared accounts → Join a shared account, a new device's link screen, or an agent's use_account) and sends it to you: a key joins an account only with its own consent.",
    who: "the shared account's owner keys",
    ownerOnly: true,
    params: [
      { key: "grant", label: "Grant code", type: "text", max: 16_384, placeholder: "bkgrant1.…" },
      { key: "label", label: "Label", type: "text", max: 64, placeholder: "public, on chain for good" },
    ],
    build: (v) => {
      const g = decodeKeyGrant(String(v.grant));
      if (g.account !== account) throw new Error(`That grant code is for another account (${g.account.slice(0, 12)}…). The key's holder must make it for ${account}.`);
      return { type: "add_key", key_id: g.key_id, label: String(v.label), role: { type: "owner" }, public_key: g.public_key, pop: g.pop };
    },
    describe: (r) => `Add “${r.label || "…"}” as an owner`,
  };
}

/** Remove an owner or revoke an agent: `remove_key`. The chain refuses one that would leave fewer owner keys than the threshold. */
export function removeKeySpec(): ActionSpec {
  return {
    id: "remove_key",
    kind: "remove_key",
    title: "Remove a key",
    blurb: "Take an owner key (a lost device, a co-owner who left) or an agent's key off the account. It fails if it would leave fewer owner keys than the threshold: lower the threshold first.",
    who: "the shared account's owner keys",
    ownerOnly: true,
    params: [{ key: "key_id", label: "Key id", type: "key_id", placeholder: "64 hex characters" }],
    build: (v) => {
      const key_id = String(v.key_id).toLowerCase();
      if (!KEY_ID.test(key_id)) throw new Error("A key id is 64 characters of 0–9 and a–f.");
      return { type: "remove_key", key_id };
    },
    describe: (r) => `Remove key ${String(r.key_id || "…").slice(0, 12)}…`,
  };
}

/** What to tell an agent so it can co-own: the MCP's and the SDK's words for the same steps. */
export function agentBrief(account: string, shape: string): string {
  return `Your Blockula key is an owner of the shared account ${account}
(${shape}: owner keys propose and approve; an action runs once enough have approved).

MCP:  call use_account with account "${account}"
      multisig_show                     (its owners, threshold and open proposals)
      multisig_propose_send             (propose a payment)
      multisig_approve                  (approve a payment you were shown, by its digest)
SDK:  await wallet.actAs("${account}");
      await wallet.multisigPropose({ type: "transfer", to: "friend.boo", amount: "1000000000" });
      await wallet.multisigApprove(id, { action });`;
}
