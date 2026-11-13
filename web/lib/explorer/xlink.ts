/**
 * An account's linked X handle, as the explorer reads it (docs/X-LINKING.md): the newest record
 * in its history, a transfer it sent itself with an `x-link:v1:<handle>:<post id>` or
 * `x-unlink:v1` memo, signed by one of its owner keys. What a record is, and the code its proof
 * post must hold, are the SDK's (`xRecordIn`, `xLinkCode`); this file only walks the history.
 *
 * The page can't open x.com (its CSP lets it talk to its node, and X sends no CORS headers), so
 * a link shows as the account's claim beside its proof post, for the reader to open. The SDK's
 * `verifyXLink` fetches the post and checks it wherever `fetch` can reach X.
 *
 * Pure but for the `get` it's handed, so `node --test` runs it directly.
 */
import { xHandle, xLinkFrom, xLinkMemo, xPostRef, xRecordIn, type XLink, type XLinkChain } from "@blockula/sdk";
import type { AccountDetail, TxDetail } from "./types";

/** How many finalized transactions `/api/account` carries in `recent_txs` (node/src/api.rs `HISTORY_PAGE`). */
export const RECENT_TXS = 25;
/** Transactions per page of `/api/account/{id}/txs` when looking further back. */
export const X_PAGE = 100;
/** Pages read before giving up: a record older than the account's newest 500 transactions isn't looked for. */
export const X_PAGES = 5;

/**
 * The memo of a link's record from the form's fields as typed: the handle (with or without `@`)
 * and the post's link. A post link that names another handle is refused: the proof has to be
 * that handle's own post.
 */
export function xRecordMemo(handle: string, post: string): string {
  const h = xHandle(handle);
  const ref = xPostRef(post);
  if (ref.handle && ref.handle.toLowerCase() !== h.toLowerCase()) throw new Error(`That post's link is under @${ref.handle}, not @${h}. The proof must be posted by @${h}.`);
  return xLinkMemo(h, ref.id);
}

/** The parts of `/api/account` a link is read from. */
export type XAccount = Pick<AccountDetail, "account" | "keys" | "recent_txs">;

/** The account's owner keys now: only what they signed is a record. */
export const ownerKeyIds = (keys: AccountDetail["keys"]) => keys.filter((k) => k.role.type === "owner").map((k) => k.key_id);

/**
 * What one stretch of history says: the link its newest record makes, `null` when that record is
 * an unlink, `undefined` when it holds no record at all (look further back).
 */
export function xLinkIn(txs: TxDetail[], account: string, owners: string[], chain: XLinkChain): XLink | null | undefined {
  const rec = xRecordIn(txs, account, owners);
  if (!rec) return undefined;
  return rec.type === "link" ? xLinkFrom(rec, account, chain) : null;
}

/** Changes whenever the account's link could have: a record is a transaction it sent, and counts only from its owner keys. */
export const xLinkKey = (rpc: string, a: Pick<AccountDetail, "account" | "nonce" | "keys">, chain: XLinkChain) => `${rpc}|${chain.chainId}|${chain.genesisHash}|${a.account.address}|${a.nonce}|${ownerKeyIds(a.keys).join(",")}`;

/**
 * The account's link, or `null`: first from the transactions `/api/account` already sent
 * (`recent_txs`), then, only if those are a full page with no record among them, from older
 * pages of its history (`get` is `nodeGet`), up to X_PAGES of them.
 */
export async function readXLink(get: (path: string) => Promise<{ txs: TxDetail[]; next: string | null }>, a: XAccount, chain: XLinkChain): Promise<XLink | null> {
  const address = a.account.address;
  const owners = ownerKeyIds(a.keys);
  if (!owners.length) return null;
  const recent = xLinkIn(a.recent_txs, address, owners, chain);
  if (recent !== undefined) return recent;
  if (a.recent_txs.filter((t) => t.status !== "pending").length < RECENT_TXS) return null;
  let before: string | null = null;
  for (let page = 0; page < X_PAGES; page++) {
    const p = await get(`/account/${encodeURIComponent(address)}/txs?limit=${X_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    const found = xLinkIn(Array.isArray(p.txs) ? p.txs : [], address, owners, chain);
    if (found !== undefined) return found;
    if (!p.next) return null;
    before = p.next;
  }
  return null;
}
