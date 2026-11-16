// lib/explorer/featured.ts: which deployed programs the wallet pins, and how they sit with recent creates.
// Run with `npm test -w @blockula/web`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createdProgramAddresses, FEATURED_PROGRAMS, featuredPrograms, featuredTable, listDeployed } from "./explorer/featured.ts";

const DEMO = "blockula-demo-2";
const GENESIS = "e712d9376917f0c9d10c164fa7c1a53fef7c8dc1c24100e7924037d0250f705e";
const REGISTRY = "boo1men67eckh4nt0xyqu553llnvf88aa6uzmvf9wcgp0wd0v3p0thds33f4yj";
const TABLE = "boo13qwnfrysk8fe4ksgyvhtfpn8zf9cgav9vym0pex3tjzn07z5t8kqnvxeus";

test("the demo chain pins the Grok Bot registry and the blackjack table, and only for that genesis", () => {
  const pins = featuredPrograms(DEMO, GENESIS);
  assert.deepEqual(pins.map((p) => p.address), [REGISTRY, TABLE]);
  assert.equal(pins[0].play, undefined);
  assert.equal(pins[1].title, "Blackjack");
  assert.equal(pins[1].play, "blackjack");
  assert.equal(pins[0].title, "Grok Bot registry");
  assert.match(pins[0].blurb, /Grok Bots/);
  assert.equal(featuredPrograms(DEMO, GENESIS.toUpperCase())[0].address, REGISTRY, "the node's hash may arrive in either case");
  assert.deepEqual(featuredPrograms(DEMO, `${GENESIS.slice(0, 63)}0`), [], "a different genesis with the same chain id shows nothing");
  assert.deepEqual(featuredPrograms("blockula-demo-2-other", GENESIS), []);
  assert.deepEqual(featuredPrograms(DEMO, undefined), []);
  assert.deepEqual(featuredPrograms(undefined, GENESIS), []);
  assert.deepEqual(featuredPrograms(DEMO, GENESIS.slice(0, 16)), [], "a prefix of the hash is not the hash");
  assert.equal(FEATURED_PROGRAMS.length, 1);
});

test("the table to offer is the chain's pinned one, else the build's, else none", () => {
  assert.equal(featuredTable(DEMO, GENESIS), TABLE);
  assert.equal(featuredTable(DEMO, GENESIS, "boo1built"), TABLE, "the chain's pin comes before the build's table");
  assert.equal(featuredTable(DEMO, `${GENESIS.slice(0, 63)}0`), undefined, "another genesis has no pinned table");
  assert.equal(featuredTable("other", GENESIS, " Boo1Built "), "boo1built");
  assert.equal(featuredTable(undefined, undefined, "boo1built"), "boo1built", "before the node answers, the build's table");
  assert.equal(featuredTable(undefined, undefined), undefined);
  assert.equal(featuredTable(DEMO, GENESIS, undefined, [{ chainId: DEMO, genesisHash: GENESIS, programs: [{ address: REGISTRY, title: "r", blurb: "b" }] }]), undefined, "a pin without a page isn't a table");
});

test("no pin's words break the copy rules", () => {
  for (const chain of FEATURED_PROGRAMS) {
    for (const p of chain.programs) {
      assert.doesNotMatch(`${p.title} ${p.blurb}`, /\b(demo|example|mainnet|contracts?|win|winnings|prize|worth|price|money)\b/i, p.title);
    }
  }
});

test("a pin list drops a blank or repeated address", () => {
  const chains = [{
    chainId: "c",
    genesisHash: "ab".repeat(32),
    programs: [
      { address: "Boo1ABC", title: "One", blurb: "first" },
      { address: "  ", title: "Blank", blurb: "no" },
      { address: "boo1abc", title: "Again", blurb: "second" },
    ],
  }];
  const pins = featuredPrograms("c", "AB".repeat(32), chains);
  assert.deepEqual(pins.map((p) => p.address), ["boo1abc"]);
  assert.equal(pins[0].title, "One");
});

test("created addresses are finalized creates, newest first, once each", () => {
  const addrs = createdProgramAddresses([
    { status: "pending", program: { facts: { created: "boo1new" } } },
    { status: "finalized", program: { facts: { created: "boo1a" } } },
    { status: "failed", program: { facts: { created: "boo1no" } } },
    { status: "finalized", program: { facts: { created: 12 } } },
    { status: "finalized", program: null },
    { status: "finalized", program: { facts: { created: "BOO1A" } } },
    { status: "finalized", program: { facts: { created: "boo1b" } } },
  ]);
  assert.deepEqual(addrs, ["boo1a", "boo1b"]);
});

test("pins come first and a recent create of the same program is not listed twice", () => {
  const listed = listDeployed(
    ["boo1recent", REGISTRY.toUpperCase(), "boo1other", ...Array.from({ length: 20 }, (_, i) => `boo1pad${i}`)],
    [REGISTRY],
    3,
  );
  assert.deepEqual(listed, [
    { address: REGISTRY, featured: true },
    { address: "boo1recent", featured: false },
    { address: "boo1other", featured: false },
    { address: "boo1pad0", featured: false },
  ]);
});
