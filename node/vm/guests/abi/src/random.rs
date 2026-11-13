//! # Randomness a program can settle on (docs/RANDOMNESS.md, docs/PROGRAMS.md 10.3)
//!
//! The chain's randomness beacon gives one value per epoch, public from the moment it's derived.
//! So the only safe way to use it is in two transactions:
//!
//! 1. **Commit before anyone knows.** Take the bet, the entry, the hand: everything the outcome
//!    will be applied to, fixed in storage, with a [`request`]. The request names the beacon two
//!    epochs ahead ([`DELAY_EPOCHS`]), which no validator has revealed anything for yet.
//! 2. **Settle later.** Once that epoch's value is derived, [`settle`] turns it into the
//!    request's own 32 bytes, and the program applies them to what step 1 fixed.
//!
//! ```ignore
//! // roll (payable): fix the stake and the pick, then
//! let req = random::request(min_reveals);
//! put(&key, &record_with(req.to_bytes()));
//!
//! // settle: anyone may call it
//! match random::settle(&req, b"dice/roll") {
//!     Outcome::Settled(value) => pay_out(random::below(&value, 6)),
//!     Outcome::Pending => abort(NOT_YET, b"not yet"),
//!     Outcome::Expired | Outcome::TooFewReveals => refund(),
//! }
//! ```
//!
//! **The rules this module keeps, and the ones it leaves to the program:**
//! - What happens on [`Outcome::Expired`] and [`Outcome::TooFewReveals`] (a refund, a forfeit) is
//!   the program's rule, and it must be **fixed when the request is made**, never chosen at
//!   settlement. If only the requester can settle, expiry must forfeit: a refund would let a
//!   loser win by never settling. If anyone can settle (as the `dice` guest does), a refund is
//!   fine: whoever gains from the result settles it.
//! - `min_reveals` is the program's, never the caller's: with no reveals the beacon is a hash
//!   chain anyone can compute ahead.
//! - Nothing that can change between the request and its settlement may decide what the value is
//!   applied to.
//! - **Never use `tx_hash`, `block_height`, `epoch`, a storage counter or the caller's address
//!   as randomness.** Whoever sends the transaction picks or predicts every one of them.
//!
//! **What the value is worth.** A validator that reveals last can withhold instead and so choose
//! between two values, at the price of a slash, its jail and its seat; `k` validators working
//! together choose among `2^k`, and all of them together know the value when they commit. Use it
//! for things worth less than a withholding validator stands to lose (docs/RANDOMNESS.md).

use crate::{abort, beacon, blake3, code, epoch, get_u64, put, self_address};

/// A request names the beacon this many epochs after the one it's made in: the first whose
/// reveals haven't started (commitments for `e + 2` are made during `e`, revealed during `e + 1`).
pub const DELAY_EPOCHS: u64 = 2;
/// A request can be settled until this many epochs after its target, half of the 64 epochs of
/// values the chain keeps: past it, [`settle`] answers [`Outcome::Expired`], whatever the beacon
/// was, so a request never waits on a value the chain has dropped.
pub const SETTLE_EPOCHS: u64 = 32;
/// Longest domain [`settle`] takes, in bytes.
pub const MAX_DOMAIN: usize = 64;
/// Where this module keeps the next request id, in the program's own storage (a `u64`, LE). A
/// program using [`request`] must not write this key itself.
pub const NEXT_ID_KEY: &[u8] = b"\0random/next";

/// A commitment to use one future beacon value, made by [`request`]. Store it (28 bytes,
/// [`Request::to_bytes`]) with whatever the value will decide.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Request {
    /// Unique among this program's requests, so two that name the same epoch settle on
    /// unrelated values.
    pub id: u64,
    /// The epoch whose beacon settles it: the request's epoch + [`DELAY_EPOCHS`].
    pub target_epoch: u64,
    /// The last epoch it can be settled in: `target_epoch` + [`SETTLE_EPOCHS`].
    pub deadline_epoch: u64,
    /// The fewest validator reveals the beacon value must hold to be used.
    pub min_reveals: u32,
}

impl Request {
    pub const BYTES: usize = 28;

    /// id 8 ‖ target epoch 8 ‖ deadline epoch 8 ‖ min reveals 4, little-endian.
    pub fn to_bytes(&self) -> [u8; Self::BYTES] {
        let mut b = [0u8; Self::BYTES];
        b[..8].copy_from_slice(&self.id.to_le_bytes());
        b[8..16].copy_from_slice(&self.target_epoch.to_le_bytes());
        b[16..24].copy_from_slice(&self.deadline_epoch.to_le_bytes());
        b[24..].copy_from_slice(&self.min_reveals.to_le_bytes());
        b
    }

    pub fn from_bytes(b: &[u8; Self::BYTES]) -> Request {
        let u64_at = |at: usize| crate::u64_at(b, at);
        let mut reveals = [0u8; 4];
        reveals.copy_from_slice(&b[24..]);
        Request { id: u64_at(0), target_epoch: u64_at(8), deadline_epoch: u64_at(16), min_reveals: u32::from_le_bytes(reveals) }
    }
}

/// What [`settle`] found.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The request's value: BLAKE3(domain ‖ this program's address ‖ request id ‖ beacon value).
    /// The same on every call from now until the deadline.
    Settled([u8; 32]),
    /// The target epoch's beacon isn't derived yet: try again later. Change nothing.
    Pending,
    /// The deadline passed. Final: apply the rule fixed at request time.
    Expired,
    /// The beacon value is there but fewer than `min_reveals` validators revealed for it. Final
    /// (a derived value never changes): apply the rule fixed at request time.
    TooFewReveals,
}

/// Commits this program to the beacon [`DELAY_EPOCHS`] epochs ahead, which nobody knows yet.
/// Call it in the transaction that fixes everything the value will decide, and store the result.
/// Takes the next id from [`NEXT_ID_KEY`] (one small storage write; the signer bonds its deposit
/// the first time).
pub fn request(min_reveals: u32) -> Request {
    let id = get_u64(NEXT_ID_KEY);
    put(NEXT_ID_KEY, &(id + 1).to_le_bytes());
    let target_epoch = epoch() + DELAY_EPOCHS;
    Request { id, target_epoch, deadline_epoch: target_epoch + SETTLE_EPOCHS, min_reveals }
}

/// Reads `request`'s outcome. `domain` (at most [`MAX_DOMAIN`] bytes) names what the value is
/// for, so one request can feed two draws that don't repeat each other. Reads only: the program
/// removes or marks the request itself once it has applied a final outcome, so it's applied once.
pub fn settle(request: &Request, domain: &[u8]) -> Outcome {
    if domain.len() > MAX_DOMAIN {
        abort(code::BAD_INPUT, b"random domain too long");
    }
    // Checked first: past the deadline nothing settles, even while the chain still keeps the
    // value, so when a request stops being settleable doesn't depend on who looks.
    if epoch() > request.deadline_epoch {
        return Outcome::Expired;
    }
    // Within the deadline the chain still keeps the target's value once it's derived (it keeps
    // 64 epochs), so "none" here means "not yet".
    let Some((value, reveals)) = beacon(request.target_epoch) else {
        return Outcome::Pending;
    };
    if reveals < request.min_reveals {
        return Outcome::TooFewReveals;
    }
    // The last three parts are fixed-size, so the bytes can't be read as another domain's.
    let mut buf = [0u8; MAX_DOMAIN + 72];
    let n = domain.len();
    buf[..n].copy_from_slice(domain);
    buf[n..n + 32].copy_from_slice(&self_address());
    buf[n + 32..n + 40].copy_from_slice(&request.id.to_le_bytes());
    buf[n + 40..n + 72].copy_from_slice(&value);
    Outcome::Settled(blake3(&buf[..n + 72]))
}

/// A number in `0..n` from a settled value (`n` at least 1): its first 8 bytes, little-endian,
/// modulo `n`. The bias is under `n / 2^64`: nothing for dice, cards or seats.
pub fn below(value: &[u8; 32], n: u64) -> u64 {
    crate::u64_at(value, 0) % n
}
