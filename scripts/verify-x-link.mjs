// Check an account's linked X handle (docs/X-LINKING.md): read its newest link record from a
// node, fetch the proof post from X's public oEmbed endpoint (no key, no account) and compare.
// Exits 0 when the link verifies, 1 when it doesn't or there's none, 2 on bad usage.
//
//   npm run build -w @blockula/sdk
//   node scripts/verify-x-link.mjs <name or address> [rpc=http://localhost:7070]
import { Client, verifyXLink } from "@blockula/sdk";

const [account, rpc = "http://localhost:7070"] = process.argv.slice(2);
if (!account) {
  console.error("usage: node scripts/verify-x-link.mjs <name or address> [rpc]");
  process.exit(2);
}

const client = new Client(rpc);
const link = await client.xLink(account);
if (!link) {
  console.log(`${account} has no X link on ${rpc} (within the history this node keeps).`);
  process.exit(1);
}
console.log(`${account} (${link.account}) recorded @${link.handle} in tx ${link.tx} (block #${link.height}).`);
console.log(`Proof post: ${link.post_url}`);
console.log(`It must be by @${link.handle} and contain ${link.code}`);
const check = await verifyXLink(link);
console.log(check.verified ? `✓ verified: ${check.reason}` : `✗ not verified: ${check.reason}`);
process.exit(check.verified ? 0 : 1);
