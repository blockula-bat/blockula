//! The chain's pulse: how many accounts were active lately, not counting validators, programs,
//! system accounts or the accounts this node's operator says are bots (`--pulse-exclude`). It's
//! one number for "is anyone using this chain?", served on `/api/status` (`pulse`) and `/metrics`
//! (`blockula_accounts_active{window=…}`).
//!
//! Read-only: it reads each account's newest history row, the same index (and the same bound,
//! `view::PEOPLE_RECENT_MAX_ACCOUNTS`) as `/api/accounts?sort=recent`, and touches no consensus
//! state. An account is active in a window when its newest finalized tx this node holds (one it
//! sent, or one that named it: a payment to it, say) is inside the window. A pruning node holds
//! only its own window of history (`history_from`), so a window reaching further back is counted
//! over what the node holds and marked incomplete.

use crate::view::{ReadView, PEOPLE_RECENT_MAX_ACCOUNTS};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The windows the pulse counts over: their label and length in days (blocks at the chain's
/// block time).
pub const WINDOWS: [(&str, u64); 2] = [("7d", 7), ("1d", 1)];

/// How often the pulse is counted again: about a minute of blocks. It reads one history row per
/// account, so it isn't redone for every block a busy explorer polls `/api/status` at.
const REFRESH_MS: u64 = 60_000;

/// Why an account isn't counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Excluded {
    Validator,
    Program,
    System,
    Bot,
}

impl Excluded {
    pub const ALL: [Excluded; 4] = [Excluded::Validator, Excluded::Program, Excluded::System, Excluded::Bot];

    pub fn key(self) -> &'static str {
        match self {
            Excluded::Validator => "validators",
            Excluded::Program => "programs",
            Excluded::System => "system",
            Excluded::Bot => "bots",
        }
    }
}

/// One window's count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub label: &'static str,
    /// Its length in blocks.
    pub blocks: u64,
    /// The first height counted: the window's start, or `history_from` when the node holds less.
    pub from: u64,
    /// Whether this node holds the window's whole history.
    pub complete: bool,
    /// Accounts active in the window that are counted.
    pub active: u64,
    /// Accounts active in the window that aren't, by why (`Excluded::key`).
    pub excluded: BTreeMap<&'static str, u64>,
}

/// The windows' counts at `height`, from each account's newest finalized tx (`last_active`; an
/// account with none this node holds is left out), skipping the accounts `why` excludes. A window
/// of `blocks` ends at `height` and starts `blocks - 1` before it (at least at block 1).
pub fn count<'a>(height: u64, history_from: u64, windows: &[(&'static str, u64)], last_active: impl IntoIterator<Item = (&'a str, u64)>, why: impl Fn(&str) -> Option<Excluded>) -> Vec<Window> {
    let mut out: Vec<Window> = windows
        .iter()
        .map(|&(label, blocks)| {
            let start = height.saturating_sub(blocks.saturating_sub(1)).max(1);
            Window { label, blocks, from: start.max(history_from), complete: history_from <= start, active: 0, excluded: Excluded::ALL.iter().map(|e| (e.key(), 0)).collect() }
        })
        .collect();
    for (addr, last) in last_active {
        // Asked only of accounts active in some window.
        let mut reason: Option<Option<Excluded>> = None;
        for w in out.iter_mut().filter(|w| last >= w.from && last <= height) {
            match *reason.get_or_insert_with(|| why(addr)) {
                Some(e) => *w.excluded.entry(e.key()).or_default() += 1,
                None => w.active += 1,
            }
        }
    }
    out
}

/// The windows in blocks at a block time: `WINDOWS`' days, at least one block each.
pub fn windows(block_time_ms: u64) -> Vec<(&'static str, u64)> {
    WINDOWS.iter().map(|&(label, days)| (label, days.saturating_mul(crate::params::blocks_per_day(block_time_ms)))).collect()
}

/// The pulse at one height.
#[derive(Clone, Debug)]
pub struct Pulse {
    pub height: u64,
    /// `None` past `PEOPLE_RECENT_MAX_ACCOUNTS` accounts: not counted.
    pub windows: Option<Vec<Window>>,
    /// The accounts `--pulse-exclude` named that resolve (addresses, and names' owners now).
    pub bots: Vec<String>,
    /// The entries that don't (a name nobody holds, or one that expired).
    pub unresolved: Vec<String>,
}

impl Pulse {
    /// Counts the pulse of `v`, leaving out `bots` (addresses or names).
    pub fn measure(v: &ReadView, bots: &[String]) -> Pulse {
        let st = &v.state;
        let mut resolved: Vec<String> = vec![];
        let mut unresolved = vec![];
        for b in bots {
            match st.resolve(b) {
                Ok(a) if !resolved.contains(&a) => resolved.push(a),
                Ok(_) => {}
                Err(_) => unresolved.push(b.clone()),
            }
        }
        let counted = (st.accounts.len() <= PEOPLE_RECENT_MAX_ACCOUNTS).then(|| {
            let rows: Vec<(&str, u64)> = st.accounts.iter().filter_map(|(a, _)| Some((a.as_str(), v.history(a, 1).first()?.0))).collect();
            let prefix = st.params.prefix();
            let why = |a: &str| {
                if st.validators.contains_key(a) {
                    Some(Excluded::Validator)
                } else if st.programs.records.get(a).is_some() {
                    Some(Excluded::Program)
                } else if crate::chain::system_account(prefix, a).is_some() {
                    Some(Excluded::System)
                } else if resolved.iter().any(|b| b == a) {
                    Some(Excluded::Bot)
                } else {
                    None
                }
            };
            count(v.height, v.history_from(), &windows(st.params.block_time_ms), rows, why)
        });
        Pulse { height: v.height, windows: counted, bots: resolved, unresolved }
    }

    /// The count in the window labelled `label`, if it was counted.
    pub fn active(&self, label: &str) -> Option<u64> {
        self.windows.as_ref()?.iter().find(|w| w.label == label).map(|w| w.active)
    }

    /// `/api/status`'s `pulse`; `label` shows an account as the API does.
    pub fn to_json(&self, label: impl Fn(&str) -> Value) -> Value {
        let windows: Vec<Value> = self
            .windows
            .iter()
            .flatten()
            .map(|w| json!({ "window": w.label, "blocks": w.blocks, "from": w.from, "complete": w.complete, "active": w.active, "excluded": w.excluded }))
            .collect();
        json!({
            "active_7d": self.active("7d"),
            "active_1d": self.active("1d"),
            "as_of": self.height,
            "windows": windows,
            "counts": "accounts whose newest finalized tx (sent, or naming them) is in the window; not validators, programs, system accounts or the accounts this node excludes as bots",
            "bots": self.bots.iter().map(|a| label(a)).collect::<Vec<_>>(),
            "bots_unresolved": self.unresolved,
            "unavailable": self.windows.is_none().then(|| format!("not counted on a chain of more than {PEOPLE_RECENT_MAX_ACCOUNTS} accounts")),
        })
    }

    /// `/metrics`' series: each window's count and whether this node holds all of it (nothing past
    /// the account cap). Its help text never says "program": a chain where programs never switched
    /// on has no word of them in /metrics (programs/api/tests.rs).
    pub fn metrics(&self) -> String {
        use std::fmt::Write as _;
        let Some(windows) = &self.windows else { return String::new() };
        let mut out = String::from("# HELP blockula_accounts_active Accounts active in the window (their newest finalized tx is in it) that are people: /api/status pulse says which accounts were left out and why\n# TYPE blockula_accounts_active gauge\n");
        for w in windows {
            let _ = writeln!(out, "blockula_accounts_active{{window=\"{}\"}} {}", w.label, w.active);
        }
        out.push_str("# HELP blockula_accounts_active_complete 1 if this node holds the window's whole history (a pruning node counts only what it holds)\n# TYPE blockula_accounts_active_complete gauge\n");
        for w in windows {
            let _ = writeln!(out, "blockula_accounts_active_complete{{window=\"{}\"}} {}", w.label, u8::from(w.complete));
        }
        out
    }
}

/// The node's pulse, counted again about once a minute of blocks.
#[derive(Default)]
pub struct PulseCache {
    /// `--pulse-exclude`: addresses or names.
    bots: Vec<String>,
    memo: Mutex<Option<Arc<Pulse>>>,
}

impl PulseCache {
    pub fn new(bots: Vec<String>) -> Self {
        Self { bots, memo: Mutex::new(None) }
    }

    /// The pulse as of `v`, or of a block less than a minute before it.
    pub fn get(&self, v: &ReadView) -> Arc<Pulse> {
        let refresh = (REFRESH_MS / v.state.params.block_time_ms.max(1)).max(1);
        let mut memo = self.memo.lock();
        match &*memo {
            Some(p) if p.height <= v.height && v.height < p.height.saturating_add(refresh) => p.clone(),
            _ => {
                let p = Arc::new(Pulse::measure(v, &self.bots));
                *memo = Some(p.clone());
                p
            }
        }
    }
}

/// `--pulse-exclude`'s values: an address, or a name (with or without `.boo`).
pub fn parse_exclude(s: &str) -> Result<String, String> {
    let s = s.trim();
    if crate::crypto::is_address(s) {
        return Ok(s.to_string());
    }
    crate::types::normalize_name(s).map(|n| format!("{n}{}", crate::types::NAME_SUFFIX)).map_err(|e| format!("{s:?} isn't an address or a .boo name: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn by_label(ws: &[Window], label: &str) -> Window {
        ws.iter().find(|w| w.label == label).unwrap().clone()
    }

    /// The windows end at the head and reach back `blocks` blocks; an account counts in each window
    /// its newest tx falls in, and validators, programs, system accounts and bots don't count but
    /// are tallied by why.
    #[test]
    fn counts_active_accounts_per_window_without_the_excluded() {
        let wins = [("week", 100), ("day", 10)];
        let rows = [
            ("alice", 1000), // the head: both windows
            ("bob", 991),    // the day's first block
            ("carol", 990),  // just before the day: the week only
            ("dave", 901),   // the week's first block
            ("erin", 900),   // just before the week: neither
            ("vlad", 999),   // a validator
            ("prog", 950),   // a program
            ("tres", 995),   // the treasury
            ("bot", 1000),   // a house bot
            ("oldbot", 10),  // a bot outside both windows: not tallied
        ];
        let why = |a: &str| match a {
            "vlad" => Some(Excluded::Validator),
            "prog" => Some(Excluded::Program),
            "tres" => Some(Excluded::System),
            "bot" | "oldbot" => Some(Excluded::Bot),
            _ => None,
        };
        let ws = count(1000, 1, &wins, rows, why);
        let week = by_label(&ws, "week");
        assert_eq!((week.active, week.from, week.complete, week.blocks), (4, 901, true, 100));
        assert_eq!(week.excluded, BTreeMap::from([("validators", 1), ("programs", 1), ("system", 1), ("bots", 1)]));
        let day = by_label(&ws, "day");
        assert_eq!((day.active, day.from, day.complete), (2, 991, true));
        assert_eq!(day.excluded, BTreeMap::from([("validators", 1), ("programs", 0), ("system", 1), ("bots", 1)]));
    }

    /// A node that pruned into the window counts what it holds and says so; a window longer than
    /// the chain starts at block 1 and is complete on a node that holds it all.
    #[test]
    fn pruned_and_young_chains() {
        let wins = [("week", 100), ("day", 10)];
        let ws = count(1000, 950, &wins, [("a", 960), ("b", 999)], |_| None);
        let (week, day) = (by_label(&ws, "week"), by_label(&ws, "day"));
        assert_eq!((week.active, week.from, week.complete), (2, 950, false));
        assert_eq!((day.active, day.from, day.complete), (1, 991, true));
        let ws = count(30, 1, &wins, [("a", 1), ("b", 25)], |_| None);
        let week = by_label(&ws, "week");
        assert_eq!((week.active, week.from, week.complete), (2, 1, true));
        assert_eq!(by_label(&ws, "day").active, 1);
        // A fast-synced young node (history from 20 on a 30-block chain) misses the start.
        assert!(!by_label(&count(30, 20, &wins, [("a", 25)], |_| None), "week").complete);
        // The exclusion is asked once per account, and only of accounts in some window.
        let asked = std::cell::Cell::new(0);
        count(1000, 1, &wins, [("in", 999), ("out", 5)], |_| {
            asked.set(asked.get() + 1);
            None
        });
        assert_eq!(asked.get(), 1);
    }

    /// Seven days and one at the chain's block time.
    #[test]
    fn windows_follow_the_block_time() {
        assert_eq!(windows(2000), vec![("7d", 302_400), ("1d", 43_200)]);
        assert_eq!(windows(1000), vec![("7d", 604_800), ("1d", 86_400)]);
    }

    #[test]
    fn exclude_entries_are_addresses_or_names() {
        assert_eq!(parse_exclude("Guestbook.boo").as_deref(), Ok("guestbook.boo"));
        assert_eq!(parse_exclude("trickortreat").as_deref(), Ok("trickortreat.boo"));
        let a = crate::crypto::Keys::from_seed([3; 32]).address();
        assert_eq!(parse_exclude(&a), Ok(a));
        assert!(parse_exclude("not a name!").is_err());
        assert!(parse_exclude("x").is_err());
    }
}
