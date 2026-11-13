import { REPO } from "@/components/Landing";
import { DEMO_NODE } from "@/lib/config";
import { X_ACCOUNT, X_URL, xWalletOf } from "@/lib/site";

const DOC = `${REPO}/blob/main/docs/X-LINKING.md`;

/**
 * How to link an X account, as blockula.app serves it: the form lives in a node's wallet
 * (`/wallet/x/`), because a passkey is bound to that origin. This page explains the steps and,
 * when a demo node is configured, links to the demo wallet's page.
 */
export function SiteXPage() {
  return (
    <main className="narrow stack-lg" data-testid="site-x-page">
      <div className="center">
        <span className="eyebrow">On your wallet</span>
        <h1>Link your X account</h1>
        <p className="lead">
          Show your X handle on your Blockula account and your .boo names. You prove it with one public post, and you can take it away again.
        </p>
      </div>

      {DEMO_NODE && (
        <p>
          <a className="btn primary big" href={xWalletOf(DEMO_NODE)} data-testid="site-x-demo-wallet">
            Open it in the demo wallet
          </a>
        </p>
      )}

      <section className="card stack">
        <h2>How it works</h2>
        <ol>
          <li>
            In a node&apos;s wallet, open <strong>Link X</strong> (or go to <code>/x</code>).
          </li>
          <li>Type your handle. The page shows a short post with your code, and a button that opens X with it filled in.</li>
          <li>Post it from that handle, as it is.</li>
          <li>Paste the post&apos;s link, preview, and sign. It costs only the fee and moves nothing. FANG is a test coin with no value.</li>
        </ol>
        <p>
          Your account&apos;s page then shows <code>x · @handle</code> and a link to the proof post. Anyone can check it: the post must be by that handle and contain the code. Link another handle to replace it, or unlink on the same page.
        </p>
      </section>

      <section className="card stack">
        <h2>Where to do it</h2>
        <p>
          blockula.app is the project&apos;s site, not a wallet. Linking is signed by an owner key in the wallet a node serves, so your passkey stays on the origin where you made it.
        </p>
        {DEMO_NODE ? (
          <p>
            On the demo chain, that&apos;s{" "}
            <a href={xWalletOf(DEMO_NODE)}>Link X in the demo wallet</a>
            . On a friend&apos;s chain, open that node&apos;s wallet and go to <code>/x</code>.
          </p>
        ) : (
          <p>
            On a friend&apos;s chain, open that node&apos;s wallet and go to <code>/x</code>.
          </p>
        )}
        <p>
          The project&apos;s only X account is{" "}
          <a href={X_URL} rel="me">
            @{X_ACCOUNT}
          </a>
          . A linked handle is not an endorsement.
        </p>
      </section>

      <p className="dim small">
        The full write-up is in <a href={DOC}>docs/X-LINKING.md</a>.
      </p>
    </main>
  );
}
