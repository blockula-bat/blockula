# Blackjack: security review

A review of the blackjack program ([BLACKJACK.md](BLACKJACK.md)) and of the pieces around it
where they touch players' or the house's FANG, with the changes it led to.

**This review was done by an AI agent (Claude), in one session, working from the source. It is
not an audit by people and doesn't replace one.** It was written to be read by the people who
do that audit: every finding names the code, and the ones that were fixed name their tests.
FANG has no value; "funds" below means FANG held by the program.

## Scope

| | |
|---|---|
| Commit reviewed | `67deeb2` (main, with #182 randomness and #185 blackjack merged) |
| Reviewed in full, line by line | `node/vm/guests/blackjack/src/lib.rs` (the program), `node/vm/guests/bj-core/src/lib.rs` (the rules, the chain, BLAKE3) |
| Reviewed where it affects fund safety or fairness | The dealer daemon (`services/blackjack/dealer/src`): what it reveals and when, timeouts, restarts. The library (`services/blackjack/core/src`): encoding, `verifyHand`. The table page (`web/app/blackjack`, `web/lib/blackjack.ts`): the seed, the bet flow. The X bot's relayer path (`services/blackjack/xbot`), as a design. The host's rules for `transfer`, storage deposits and failed calls, as `docs/PROGRAMS-V0.md` and `guests/abi` state them. |
| Fixes | This branch (`blackjack-commit-reveal`). Line numbers below are this branch's unless they say `67deeb2`. |

**Not reviewed.** The VM and the node themselves (metering, the engines, the overlay and commit
of a program's writes, consensus, the mempool): the host's behaviour was taken from its
documentation and its tests, not re-derived. The SDK's signing and the passkey wallet. The
renderer and the X bot beyond the relayer's trust. The compiled `blackjack.wasm` was not
disassembled; `build.sh --check` shows it is the source's build. The BLAKE3 in `bj-core` was
read and is held to the `blake3` crate by tests for every one-chunk length, but was not proven.
No fuzzing campaign was run and nothing was formally verified. The game's odds (the house's
edge under these rules) were not computed. Operational security of a real deployment (keys,
hosts, monitoring) is outside it.

## Method

1. Read both crates in full and wrote down, for every method, who may call it, what it moves
   and what it trusts.
2. For each kind of actor (the owner, the dealer, a player, a relayer, a stranger, someone
   watching the mempool, a block producer, the node a wallet or the dealer talks to) asked what
   they can do out of turn, and what they gain.
3. Checked the accounting by hand on every path that moves FANG (`fund`, `defund`, `deposit`,
   `withdraw`, `relay_withdraw`, `bet`, `relay_bet`, `settle` with a transfer that goes through
   and one that fails), and against the tests' invariant check, which runs after every
   successful call.
4. Checked arithmetic (overflow, casts, rounding), the deadlines and the day window at their
   edges, the limits' validation, and the longest hand against the chain's length.
5. Wrote tests for what was changed, and ran the suites in "What was run" below.

Severity is the usual scale: **Critical** (anyone can take or lock funds), **High** (a party
the design means to constrain can take funds or decide outcomes), **Medium** (needs a
privileged or well-placed party, or bounded loss), **Low** (griefing, small or unlikely loss),
**Info** (worth knowing; no loss).

## Summary

No Critical finding. One High finding (the gap the docs already named), fixed. Two Medium
findings fixed or made explicit in code, two that are properties of the design and are
documented, not fixed.

| Id | Severity | Finding | Status |
|---|---|---|---|
| BJ-01 | High | A bet's seed was public before its hand held a commitment: the house could choose which commitment it met | Fixed in this branch |
| BJ-02 | Medium | The owner could use `set_limits` on a hand in play: force a stand, or let the dealer stall for good | Fixed in this branch (bounds); the rest accepted |
| BJ-03 | Medium | Relayed play: the relayer picks the timing and supplies the post id the seed comes from | Deferred (design; documented) |
| BJ-04 | Medium | New with BJ-01's fix: whoever can keep a seed's reveal off the chain takes the stake | Accepted (documented); a wallet-side answer deferred |
| BJ-05 | Low | A chain-wide pause of programs ends hands by the clock: bets waiting for a seed are lost | Accepted (documented) |
| BJ-06 | Low | The daily cap is a fixed window: twice the cap across a boundary; `day_blocks` changes renumber it | Accepted (documented) |
| BJ-07 | Low | Seats and commitments can be used up cheaply by idle hands | Accepted (documented) |
| BJ-08 | Low | Anyone can get ahead of the dealer's reveal with its first link, failing the dealer's transaction | Accepted (documented) |
| BJ-09 | Low | Post ids aren't unique or ordered: a relayer can reuse one | Deferred with BJ-03 |
| BJ-10 | Info | A dealer that is already late gives the player a look at its reveal before choosing the timeout | Accepted |
| BJ-11 | Info | The dealer daemon acts on what one node tells it; a failed reveal still publishes its links | Accepted (the daemon requires a local node) |
| BJ-12 | Info | The seed sits in the browser's storage, and the page's origin is trusted with it | Accepted |
| BJ-13 | Info | Arithmetic relies on the guest profile's `overflow-checks` | Accepted |
| BJ-14 | Info | `set_limits` accepts values that refuse every bet | Accepted |
| BJ-15 | Info | A player's record is never removed: its deposit doesn't come back | Accepted |
| BJ-16 | Info | The owner can't be changed: a lost owner key strands the bankroll | Accepted (documented) |

What was checked and found sound is listed after the findings.

## Findings

### BJ-01 (High): a bet's seed was public before its hand held a commitment

**Where.** `67deeb2`: `guests/blackjack/src/lib.rs:770` (`bk_bet` took `client_seed` as its
input), `:688` (`open_hand` took the next commitment in order), `:492` (`bk_skip_commits`).

**What.** A bet was one transaction carrying the player's seed. From the moment it waited in
the mempool, anyone holding the dealer's secrets knew what the next commitment would deal that
seed. Commitments are taken in order, so the house could change which one the bet met. Two
ways, the second cheaper than the one the docs described:

- a bet of the house's own placed in front (it takes commitment `k`; the player's bet meets
  `k + 1`);
- the owner's `skip_commits`, in front of the bet: it drops commitment `k` at no stake and
  with no hand to play.

Repeating either, a house that could order transactions ahead of a player's (a block producer,
or just a higher tip) could move a bet along until it met a chain that loses.

**Impact.** The house decides the outcome of any hand it chooses, within what its next few
chains happen to deal. It leaves a trail (skips and house bets in front of displaced bets) but
a player can't tell from one hand.

**Fix (this branch).** A bet is two transactions. `bet` (`lib.rs:814`) carries the stake and
`seed_hash = BLAKE3("blockula/blackjack/seed" ‖ player ‖ client_seed)` (`bj-core/src/lib.rs:197`)
and takes the commitment, the reserve and every limit as before; the hand waits in a new phase
0. `reveal_seed` (`lib.rs:831`), from the same account and within `seed_blocks`, opens it, and
only then may the dealer reveal a link (`bk_reveal` refuses one in phase 0, abort 57) and only
then does its deadline run. So when the seed is public the hand already holds its commitment.
The hash binds the account, so a copied hash can't be opened by the copier. A seed that never
comes ends the hand as outcome 8 by `timeout` (`lib.rs:1135`): the stake to the bankroll, the
reserve and the seat freed, the commitment spent. A seed past its deadline is refused (abort
72) rather than left to race the timeout, because a late seed in the mempool would give whoever
saw it the choice. [BLACKJACK.md](BLACKJACK.md) section 2 has the reasoning for the forfeit.

What a front-runner can still do is displace a bet *blind*: seeing only a hash and a stake, a
bet (or a skip) in front changes which commitment the player's bet takes, with no knowledge of
what either would deal. That gains nothing.

**Tests.** `node/vm/tests/blackjack.rs`: `nobody_who_sees_a_bet_or_its_seed_can_steer_the_hand`
(a seed that wins on chain 0 and loses on chain 1; with the seed visible the house skips
commitments, bets in front, tries to reveal for the player, to deal early, to time the hand out
and to rename the dealer, and the hand is still dealt from chain 0; a copied hash can't be
opened and costs its stake), `a_seed_opens_the_bet_it_was_committed_to_and_nothing_else_does`
(wrong seed 71, another account 55, a second seed 70, a late seed 72, a relayed hand 70),
`a_seed_that_never_comes_forfeits_the_stake_to_the_house`, the soak (outcome 8 among 400
hands, the invariant after every call). `tests/blackjack_rules.rs`: the hash against the
`blake3` crate, and vectors the TypeScript side checks. The library, the dealer daemon, the
table page (Playwright: the two steps, a reload between them, a browser without the seed, a
late seed) and the four-validator run all place bets this way.

### BJ-02 (Medium): the owner could use `set_limits` on a hand in play

**Where.** `67deeb2` `lib.rs:436` (`bk_set_limits`: every block count only had to be 1 to
2^40). Deadlines are computed from the limits in force when they are set: `lib.rs:933` (a hit
or a stand), `:1104` (the player's turn), `:1141` (an idle stand).

**What.** The owner sets the limits at any time, and the house knows every card of an open
hand. Two uses:

- `idle_blocks = 1`, then back. A hand dealt meanwhile gives its player one block to move;
  the house calls `timeout` in the next and the player stands. The house can do that exactly
  when a hit would have helped the player.
- `reveal_blocks = 2^40`. A hit or stand after that gives the dealer about 70,000 years. The
  dealer can then hold back any card for good: the hand never settles, the player's stake and
  its reserve stay locked, and "stalling never pays the house better than dealing" stops being
  true (a hand the house would lose is simply never finished).

With BJ-01's fix a third would have been possible: `seed_blocks = 1` takes a stake before its
seed can arrive.

**Impact.** The owner, a party the program otherwise constrains ("can't touch a reserve, a
stake"), could take a player's choice or freeze a player's stake. It is visible on the chain
(a `limits` event), which bounds it to a house willing to be seen.

**Fix (this branch).** `set_limits` refuses `idle_blocks` or `seed_blocks` under 20
(`MIN_PLAYER_BLOCKS`, `lib.rs:203`) and `reveal_blocks` over 86,400 (`MAX_DEALER_BLOCKS`,
`lib.rs:207`; `lib.rs:483`). Test: `limits_are_the_owners_and_checked`.

**What remains (accepted).** Inside the bounds, a change still applies to deadlines set after
it, so an owner can shorten a player's next turn to 20 blocks or lengthen the dealer's to
86,400 mid-hand. Recording a hand's limits at its bet would close that; it costs record space
and a layout change, and the bounds remove the harm that mattered. The floors are in blocks:
on a chain with very short blocks 20 blocks is little time, and an operator should not set
limits near them.

### BJ-03 (Medium): relayed play trusts the relayer with timing and with the seed's input

**Where.** `lib.rs:871` (`bk_relay_bet`), `:903` (the seed: `BLAKE3("blockula/blackjack/relay"
‖ player ‖ post id)`).

**What.** The docs said a relayed bet's seed "is not the relayer's choice". The post id is
whatever 8 bytes the relayer passes; the program can't check it against X. A relayer working
with the dealer can therefore try post ids until the derived seed loses on the next chain. It
also chooses when to submit (the last look the docs did describe), and with `skip_commits` or
bets of its own in front, a house needs neither to be subtle.

**Impact.** A dishonest relayer that knows the dealer's secrets decides relayed hands, within
the grant's limits (per bet, per day, an expiry) and the player's table balance. Made-up post
ids can be found afterwards by comparing `relayed` events with the player's real posts, so it
is detectable, not prevented.

**Status: deferred.** Relayed bets were left out of the seed's commit and reveal on purpose:
there is no player's wallet in that path to keep a secret, and a seed the relayer commits and
reveals would be the relayer's choice outright. Closing this needs either a signature from the
player on each bet (which is the table page's path) or randomness the chain provides (protocol
v3's beacon, not on today's chains). The docs now say what is trusted (BLACKJACK.md section 2,
the X bot's README), and the bot remains dry run. Decide before the bot is ever given an X
client.

### BJ-04 (Medium, new with the fix): keeping a seed's reveal off the chain takes the stake

**Where.** `lib.rs:850` (a seed past its deadline is refused), `:1135` (the forfeit).

**What.** The second transaction has a deadline and the bet is lost if it is missed. A party
that can keep a player's `reveal_seed` out of every block for `seed_blocks` takes the stake:
the node the wallet submits through, if it swallows the transaction and the wallet tries no
other; or the chain's block producers acting together. A house in that position has seen the
seed in the transaction it is suppressing, so it can lose only the reveals of hands the player
would have won.

**Impact.** Bounded to the stake of each bet, and to parties who control a player's whole path
to the chain. The table page is served by a node and submits through that node, so a table
whose page is served by the house's own node, on a chain whose other block producers never
hear the transaction, is exposed.

**Why it isn't fixed in the program.** Any rule for an unrevealed bet pays the censor
something. A refund instead of a forfeit lets the same party cancel exactly the hands the
player would have won (and lets anyone hold seats and burn commitments for free). Counting a
late seed lets whoever sees it choose between it and the timeout. The forfeit with a strict
deadline is the rule with no free option for either side when transactions do reach the chain.

**What limits it now.** `seed_blocks` can't be set under 20 and is 300 by default; a signed
reveal is valid at any node until its deadline; the page keeps the seed and re-offers the
reveal on every load until the deadline; a reveal that was signed and never included is
something a player can show.

**Recommendation (deferred).** Have the wallet submit a seed's reveal through more than one
node and warn when it hasn't landed after a few blocks. Tell operators (done: BLACKJACK.md
sections 2, 9, 10) that a run of outcome 8 from different accounts is the table's problem.

### BJ-05 (Low): a chain-wide pause of programs ends hands by the clock

**Where.** Deadlines are block heights (`lib.rs:850`, `:1132`); `docs/PROGRAMS-V0.md` §7.2.

**What.** Validators can pause programs for days. Calls are refused meanwhile, heights keep
counting. When the pause lifts, a bet that was waiting for its seed is past its deadline and
can only be forfeited; a hand waiting for the dealer can be claimed by its player (the docs
named that half already).

**Impact.** Players lose the stakes of bets caught between their two transactions; the house
can lose up to `max_exposure`. Rare, and outside the table's control.

**Status: accepted, documented** (BLACKJACK.md section 9). The program can't see a pause. An
owner can make such players whole from its own account.

### BJ-06 (Low): the daily cap is a fixed window

**Where.** `lib.rs:758` (`day = height / day_blocks`).

**What.** An account can wager the cap in the last blocks of one window and again in the first
of the next. `set_limits` with another `day_blocks` renumbers the windows: an account's
counter can reset early, or (if the new number equals its stored one) carry an old total.

**Impact.** The cap bounds a day's wagers to twice its figure in the worst case. No funds at
risk. **Accepted, documented.**

### BJ-07 (Low): seats and commitments can be used up cheaply

**Where.** `lib.rs:750` (`max_open_games`), `:763` (one commitment a bet).

**What.** A hand whose player never moves holds a seat and its reserve for `idle_blocks`
(1,800 by default); ten accounts fill the default table for that long at the cost of playing
ten minimum hands. Many small bets also use commitments as fast as the dealer posts them, and
each costs the dealer three fees. A bet whose seed never comes holds a seat for `seed_blocks`
but costs its whole stake.

**Impact.** The table can be made unavailable for the price of small stakes at ordinary odds.
**Accepted, documented** (the docs' "idle players hold seats"). Lower `idle_blocks` (not under
20) if it happens.

### BJ-08 (Low): getting ahead of the dealer's reveal with its first link

**Where.** `lib.rs:1060` (`bk_reveal`: anyone may submit a link; `:1085` a call whose first
link isn't the chain's next fails whole).

**What.** Someone who sees the dealer's reveal waiting can submit its first link alone, first.
The dealer's transaction then fails (and pays its fee), and the daemon sends the rest on its
next look. Each round still deals a card, so it delays a hand by at most one round per card
(twelve at most), far inside `reveal_blocks` at the default. A player has a reason to try: a
dealer that misses its deadline pays them.

**Impact.** Fees for the dealer, a delay. It becomes a loss only if `reveal_blocks` is set
close to the number of cards, or the dealer's account runs out of fee money. **Accepted,
documented** ("keep `reveal_blocks` well above 12"); the daemon warns on a low balance. A
`reveal` that skipped links already revealed would remove it; not done here.

### BJ-09 (Low): post ids aren't unique or ordered

**Where.** `lib.rs:871`, `:910` (`relay_*` take a post id and emit it).

**What.** Nothing stops a relayer passing the same post id for two bets, or any id for a move.
The `relayed` event is a record, not a check. **Deferred with BJ-03**: requiring a player's
post ids to increase would stop reuse but not invention, and the relayer is trusted within the
grant either way.

### BJ-10 (Info): a late dealer gives the player a look

A dealer's reveal that arrives after its deadline still counts until someone calls `timeout`.
A player who sees that late reveal waiting can read its cards and choose: let it in, or call
`timeout` first and be paid the most the hand could have paid. That is only ever in the
player's favour and only when the dealer is already at fault. (A late *seed* is refused for
the mirror-image reason, BJ-01.) **Accepted.**

### BJ-11 (Info): the dealer daemon acts on what one node tells it

The daemon reveals the links a hand is owed according to the hand's record as its node reports
it. A reveal's links are public the moment it is submitted, even if the call then fails. A
node that lied about a hand's phase (said the player stood when they hadn't) would have the
daemon publish the next links early, which is the next card a player would be dealt. The
daemon refuses any node but one on its own machine unless told otherwise, and its README says
to run that node yourself. Executed state on this chain is final, so a truthful node's reading
doesn't revert. With the fix the daemon never reveals for a hand whose seed isn't on the
chain (`services/blackjack/dealer/src/dealer.ts:357`). **Accepted.**

### BJ-12 (Info): the seed lives in the browser

Between the two transactions the seed's secrecy matters, and it sits in the page's
`localStorage`. Script running in the page's origin (the site that serves the wallet, an
extension) could read it; a browser that loses its storage loses the bet. The page says so
when the seed isn't there. This is the trust any web wallet asks of its origin. **Accepted.**

### BJ-13 (Info): arithmetic relies on `overflow-checks`

The program adds and subtracts with plain `+` and `-` (`lib.rs:308`, `:313` and elsewhere).
The guests' release profile sets `overflow-checks = true` (`guests/Cargo.toml:27`), so an
overflow traps and the call fails instead of wrapping. Every sum was checked by hand: amounts
are bounded by the supply (10^18 drops), a reserve is at most 1.5 × that, a payout 2.5 ×, all
inside `i64` (which the host's `transfer` takes) and `u64`; block counts are bounded by 2^40.
No path was found that overflows or underflows. Keep the profile flag: the reasoning leans on
it as a second line. **Accepted.**

### BJ-14 (Info): limits that refuse every bet

`set_limits` accepts a `daily_cap` under `min_bet`, a `max_exposure` under 1.5 × `min_bet`, a
`deposit_cap` of 0. Each only stops new bets or deposits; open hands settle and withdrawals
work. The owner's to set, visible, and undone by another call. **Accepted.**

### BJ-15 (Info): a player's record stays

A player's record (195 bytes) is created by their first bet, deposit, grant or `revoke`, bonded
by whoever signed, and never removed, so that deposit doesn't come back. It is small, and
nobody can create a record for someone else. **Accepted.**

### BJ-16 (Info): the owner can't be changed

`defund` pays only the owner (`lib.rs:454`). A lost owner key strands the free bankroll;
players' stakes, reserves and table balances are unaffected. **Accepted, documented.**

## Checked and found sound

- **The invariant** `balance = bankroll + reserved + stakes + table` holds on every path. Each
  method moves FANG between counters by the amount it moves on the balance; `settle`
  (`lib.rs:986`) releases exactly the stake and the reserve the bet set aside, and pays at most
  their sum. The program takes no plain transfers, so nothing arrives uncounted.
- **A payout that can't be sent** becomes the player's table balance (`lib.rs:1036`); a plain
  transfer runs no code, so there is nothing to re-enter. A hand always settles.
- **3:2 rounds down** for the player, and the reserve rounds the same way
  (`bj-core/src/lib.rs:288`, `:295`): a payout never exceeds stake + reserve.
- **Authorization.** `init` once, by the creator, in the create (an `init` method can't be
  called later). Owner: `defund`, `set_limits`, `pause`, `set_dealer`, `approve_relayer`,
  `skip_commits`. Dealer: `commit_batch`. Player: `bet`, `reveal_seed`, `hit`, `stand`,
  `deposit`, `withdraw`, `set_relayer`, `revoke`, each on their own hand or balance only.
  Relayer: `relay_*`, only with the player's unexpired grant and the owner's approval, on table
  hands only, and a balance goes nowhere but to its depositor. Anyone: `fund`, `reveal` (a link
  is its own authorization), `timeout` (past a deadline).
- **The chain.** A link is accepted only if it hashes to the last one (`lib.rs:1085`), so the
  dealer can reveal only the chain it committed; commitments are taken strictly in order and
  each once; a batch names its start, so a repeated batch is refused; `skip_commits` touches
  only unused commitments. The hole card is the link after the player's last card and isn't
  revealed before the stand.
- **Chain length.** No hand takes more than 20 player cards and 12 dealer cards (worked by
  hand, and searched exhaustively in `tests/blackjack_rules.rs`); 32 links are exactly enough,
  and a reveal carries at most the 12 the longest dealer turn needs.
- **Card derivation.** Each card hashes the link, the seed, the game id and the index, so no
  two cards or hands share a preimage; the four kinds of hash the program makes (a link: 32 bytes; a
  card: 73; a seed's hash: 87; a relayed seed: 64) differ in length. The modulo bias is 16 in
  2^64.
- **Timeouts.** A dealer's missed deadline pays the most the hand could still have paid, so
  holding back a seen card never helps the house. A hand in any phase has a deadline and a way
  to end; nothing found leaves a hand that can't be settled or forfeited (BJ-02's stall was the
  exception, now bounded).
- **Storage deposits** go back to whoever bonded them; the dealer's reveals, a seed's reveal
  and timeouts bond nothing, so they can't be made to fail for want of a storage limit.
- **Fuel.** The most any method used is under 600,000 of the 10,000,000 a transaction may
  have; the longest possible reveal about 1.3 million.

## What was run

On this branch, on macOS (arm64), with the repo's pinned toolchain:

- `cargo test --release --locked --manifest-path node/vm/Cargo.toml` (and with
  `--features ref038`), `node/vm/guests/build.sh --check`, `scripts/clippy.sh`.
- `npm test` for `@blockula/blackjack`, `-dealer`, `-render`, `-xbot`, `@blockula/web`; the
  web typecheck; the Playwright specs for the table page.
- `scripts/blackjack-e2e.sh` (four validators, the dealer daemon as a process, restarts, a
  stall, seeds that never come, the invariant at every block) and the dealer's and the X bot's
  live tests on local chains.

The exact commands and results are in the pull request that carries this file.
