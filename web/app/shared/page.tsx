"use client";

import { isAddress } from "@blockula/sdk";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireWallet, Splash } from "@/components/Gate";
import { SharedAccounts } from "@/components/shared";
import { MAINNET_PREFIX } from "@/lib/config";
import { useWallet } from "@/lib/wallet";

/**
 * Shared accounts (multisig): the account this wallet acts for (make it shared, or see its owners
 * and proposals and propose an action), this device's key, and the other accounts the key is on.
 * `?account=<address>` (a link another owner sent) only says which account the reader means: when
 * it isn't the one the wallet acts for, the page offers to switch to it.
 */
export default function SharedPage() {
  return (
    <RequireWallet>
      <Suspense fallback={<Splash />}>
        <Shared />
      </Suspense>
    </RequireWallet>
  );
}

function Shared() {
  const params = useSearchParams();
  const { client } = useWallet();
  const raw = params.get("account")?.trim().toLowerCase() ?? "";
  // A link is anyone's text: only an address of this chain is read from it.
  const linked = raw && isAddress(raw, client.pin.prefix ?? MAINNET_PREFIX) ? raw : null;
  return <SharedAccounts linked={linked} />;
}
