"use client";

// An account's linked X handle on explorer pages (docs/X-LINKING.md): the handle its newest
// record names, beside the post that proves it. The record is the account's claim; the proof is
// on X, where this page can't look (its CSP lets it talk only to its node), so the chip says
// what to check and links the post. Rules are the SDK's and lib/explorer/xlink.ts.
import "@/app/creators.css";
import type { XLink, XLinkChain } from "@blockula/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Ext } from "@/components/explorer/kit";
import { RPC } from "@/lib/config";
import { nodeGet, useNode } from "@/lib/explorer/node";
import { to } from "@/lib/explorer/routes";
import type { AccountDetail, ChainStatus } from "@/lib/explorer/types";
import { readXLink, xLinkKey } from "@/lib/explorer/xlink";
import { useWallet } from "@/lib/wallet";

/** Links already read, by node, chain, account, nonce and owner keys: a history is walked once until the account sends again. */
const known = new Map<string, XLink | null>();
const KNOWN_MAX = 200;

/** The chain a proof code is for: the wallet's pin, else what the node's status says. */
export function useXChain(): XLinkChain | null {
  const { client } = useWallet();
  const pinned = client.pin.chainId && client.pin.genesisHash ? { chainId: client.pin.chainId, genesisHash: client.pin.genesisHash } : null;
  const status = useNode<ChainStatus & { genesis_hash?: string }>(pinned ? null : "/status");
  if (pinned) return pinned;
  const s = status.data;
  return s?.chain_id && typeof s.genesis_hash === "string" && /^[0-9a-f]{64}$/.test(s.genesis_hash) ? { chainId: s.chain_id, genesisHash: s.genesis_hash } : null;
}

/**
 * The account's X link: `undefined` while it's being read, `null` when it has none (or this node
 * couldn't say). Read again only when the account's nonce or owner keys change.
 */
export function useXLink(a: AccountDetail | undefined | null): XLink | null | undefined {
  const chain = useXChain();
  const key = a && chain ? xLinkKey(RPC, a, chain) : null;
  const [read, setRead] = useState<{ key: string; link: XLink | null } | null>(null);
  useEffect(() => {
    if (!key || !a || !chain) return;
    if (known.has(key)) return setRead({ key, link: known.get(key) ?? null });
    let stop = false;
    readXLink(nodeGet, a, chain).then(
      (link) => {
        if (known.size >= KNOWN_MAX) known.delete(known.keys().next().value as string);
        known.set(key, link);
        if (!stop) setRead({ key, link });
      },
      // A node that can't list the history: nothing to show now, asked again on the next load.
      () => !stop && setRead({ key, link: null }),
    );
    return () => void (stop = true);
    // `key` changes whenever the account's link could have (its nonce, its owner keys, the chain):
    // the account object itself is new on every poll, and isn't a reason to read again.
  }, [key]);
  return read && read.key === key ? read.link : undefined;
}

/** What makes a link real, for the proof's tooltip. */
const howToCheck = (link: XLink) =>
  `This account recorded @${link.handle} as its X account (block #${link.height.toLocaleString("en-US")}). The link is real only if this post is by @${link.handle} and contains ${link.code}. This page talks only to its node, so open the post to check.`;

/**
 * `x · @handle` and its proof post. The handle is the account's claim until the post is checked,
 * and this page can't check it, so the pill says "claimed" (as an unverified GitHub link says
 * "unverified") and leads to the post.
 */
export function XChip({ link }: { link: XLink }) {
  return (
    <span className="cre-gh" data-testid="x-link">
      <Ext className="chip" href={link.profile_url}>
        <span title={`Recorded by this account in transaction ${link.tx.slice(0, 10)}…`}>x · @{link.handle}</span>
      </Ext>
      <Ext className="pill pending cre-gh-pill" href={link.post_url}>
        <span data-testid="x-proof" title={howToCheck(link)}>
          claimed · proof post
        </span>
      </Ext>
    </span>
  );
}

/** The chip for an account already loaded (its page), if it has a link. */
export function XLinkChip({ account }: { account: AccountDetail }) {
  const link = useXLink(account);
  return link ? <XChip link={link} /> : null;
}

/** The chip for an account known only by address (a name's owner): reads the account first. */
export function XLinkOf({ address }: { address: string }) {
  const acct = useNode<AccountDetail>(`/account/${encodeURIComponent(address)}`);
  const link = useXLink(acct.data?.account.address === address ? acct.data : null);
  return link ? <XChip link={link} /> : null;
}

/** Where an account's owner links, changes or removes its X account. */
export function XLinkManage({ linked }: { linked: boolean }) {
  return (
    <Link className="btn small ghost" href={to.x()} data-testid="x-manage">
      {linked ? "Change X link" : "Link X"}
    </Link>
  );
}
