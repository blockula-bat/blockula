"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireWallet, Splash } from "@/components/Gate";
import { ReviewProposal } from "@/components/shared";
import { Spinner } from "@/components/ui";
import { MAINNET_PREFIX, NETWORK } from "@/lib/config";
import { readCosignLink } from "@/lib/multisig";
import { checkLinkChain, linkChain } from "@/lib/paylink";
import { useWallet } from "@/lib/wallet";

/**
 * A co-sign link's page (lib/multisig.ts `cosignLink`): one open proposal of a shared account,
 * rendered by this wallet from the stored action, with what an approval binds, and the approval
 * itself. The link picks the proposal; it never says what the proposal does.
 */
export default function ReviewPage() {
  return (
    <RequireWallet>
      <Suspense fallback={<Splash />}>
        <Review />
      </Suspense>
    </RequireWallet>
  );
}

function Review() {
  const params = useSearchParams();
  const { client, status } = useWallet();
  const chain = checkLinkChain(linkChain(params), client.pin);
  const ref = readCosignLink(params, client.pin.prefix ?? MAINNET_PREFIX);
  let body;
  if (chain.state === "mismatch")
    body = (
      <section className="card" data-testid="review-problem">
        <p className="m0">
          {chain.why === "malformed" ? "This link names its network in a form no Blockula network uses." : `This link was made on another network, not the one this wallet is on (${NETWORK.label}). A proposal there isn't one here.`}
        </p>
      </section>
    );
  // Until the node has said which chain (and prefix) it is, the link waits.
  else if (chain.state === "pending" || !status) body = <section className="card"><Spinner>Checking which chain this is…</Spinner></section>;
  else if (!ref.ok) body = <section className="card" data-testid="review-problem"><p className="m0">{ref.problem}</p></section>;
  else body = <ReviewProposal account={ref.account} id={ref.id} linkedDigest={ref.digest} />;
  return (
    <main className="narrow stack-lg">
      <Link href="/shared" className="back">← Shared accounts</Link>
      <h1>Review a proposal</h1>
      {body}
    </main>
  );
}
