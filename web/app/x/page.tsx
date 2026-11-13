import type { Metadata } from "next";
import { SiteXPage } from "@/components/site/XLinking";
import { SITE } from "@/lib/config";
import WalletXPage from "./WalletXPage";

export const metadata: Metadata = {
  title: "Link your X account · Blockula",
  description:
    "Show your X handle on a Blockula account with one public post. The project's only X account is @BlockulaChain. FANG is a test coin with no value.",
};

/**
 * In a wallet (`RequireWallet`, app/x/WalletXPage.tsx): the form that posts the code and records
 * the link. On the project site (blockula.app): a page that explains how, and sends you to /x
 * in a node's wallet, where the passkey lives. The site is not itself a wallet.
 */
export default function XPage() {
  return SITE ? <SiteXPage /> : <WalletXPage />;
}
