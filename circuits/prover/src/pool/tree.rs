//! Native incremental Merkle tree — the off-chain mirror of the pool's on-chain root.
//!
//! The contract stores only the root (it cannot hash), so this is the authoritative implementation:
//! the backend indexer rebuilds it from events to serve membership paths, the folder uses its
//! [`frontier`](MerkleTree::frontier) as the fold circuit's witness, and the wallet uses it to build
//! spend proofs. All three must agree with the in-circuit gadgets in [`super::gadgets`].
//!
//! Insertion is the standard incremental algorithm: walking up from the new leaf, a node is either a
//! **left** child (its right sibling is still empty, so combine with `zeros[level]` and remember this
//! node as the level's filled subtree) or a **right** child (combine with the remembered
//! `filled_subtrees[level]`). That keeps appends O(depth) without holding the whole tree.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;

use super::{empty_leaf, zero_hashes, DEPTH};
use crate::poseidon_hash2;

/// A membership path: sibling hashes from the leaf upward, plus the index that fixes left/right.
#[derive(Clone, Debug)]
pub struct MerklePath {
    pub leaf_index: u64,
    /// Exactly [`DEPTH`] siblings, bottom-up.
    pub siblings: Vec<Fr>,
    /// The root these siblings hash to — the spend proof's public input.
    pub root: Fr,
}

/// An append-only tree of note commitments.
#[derive(Clone)]
pub struct MerkleTree {
    cfg: PoseidonConfig<Fr>,
    zeros: [Fr; DEPTH + 1],
    /// Every leaf inserted so far. Kept so membership paths can be served; the contract holds none
    /// of this, only the root.
    leaves: Vec<Fr>,
    /// Per level, the most recent complete left-subtree root — the incremental frontier.
    filled_subtrees: [Fr; DEPTH],
    root: Fr,
}

impl MerkleTree {
    /// An empty tree: the root is the all-zeros subtree of height [`DEPTH`].
    pub fn new(cfg: &PoseidonConfig<Fr>) -> Self {
        let zeros = zero_hashes(cfg);
        Self {
            cfg: cfg.clone(),
            zeros,
            leaves: Vec::new(),
            filled_subtrees: core::array::from_fn(|i| zeros[i]),
            root: zeros[DEPTH],
        }
    }

    pub fn root(&self) -> Fr {
        self.root
    }

    /// Number of leaves inserted — the index the next append lands at.
    pub fn next_index(&self) -> u64 {
        self.leaves.len() as u64
    }

    pub fn zeros(&self) -> &[Fr; DEPTH + 1] {
        &self.zeros
    }

    /// The frontier the fold circuit witnesses. Bound by the root: a second frontier consistent with
    /// the same root would be a Merkle collision, which is what makes witnessing it safe.
    pub fn frontier(&self) -> [Fr; DEPTH] {
        self.filled_subtrees
    }

    /// Append one leaf, returning its index. Panics if the tree is full (2^DEPTH leaves).
    pub fn insert(&mut self, leaf: Fr) -> u64 {
        let index = self.leaves.len() as u64;
        assert!(index < (1u64 << DEPTH), "merkle tree is full");

        let mut cur = leaf;
        let mut idx = index;
        for level in 0..DEPTH {
            if idx.is_multiple_of(2) {
                // Left child: nothing to the right yet, so pair with the empty subtree and remember
                // this node — the next insertion at this level will pair against it.
                self.filled_subtrees[level] = cur;
                cur = poseidon_hash2(&self.cfg, cur, self.zeros[level]);
            } else {
                cur = poseidon_hash2(&self.cfg, self.filled_subtrees[level], cur);
            }
            idx /= 2;
        }

        self.root = cur;
        self.leaves.push(leaf);
        index
    }

    /// Every level of the tree, bottom-up, each padded to even width with the level's zero hash.
    /// Used to serve paths; O(n) so it is a test/indexer helper, never a hot path.
    fn levels(&self) -> Vec<Vec<Fr>> {
        let mut levels: Vec<Vec<Fr>> = Vec::with_capacity(DEPTH + 1);
        let mut cur = if self.leaves.is_empty() {
            vec![empty_leaf()]
        } else {
            self.leaves.clone()
        };
        for level in 0..DEPTH {
            if cur.len() % 2 == 1 {
                cur.push(self.zeros[level]);
            }
            levels.push(cur.clone());
            cur = cur
                .chunks(2)
                .map(|p| poseidon_hash2(&self.cfg, p[0], p[1]))
                .collect();
        }
        levels.push(cur);
        levels
    }

    /// The membership path for `leaf_index`, for use as a spend proof's private witness.
    pub fn path(&self, leaf_index: u64) -> MerklePath {
        assert!(
            leaf_index < self.leaves.len() as u64,
            "leaf {leaf_index} has not been inserted"
        );
        let levels = self.levels();
        let mut siblings = Vec::with_capacity(DEPTH);
        let mut idx = leaf_index as usize;
        for (level, nodes) in levels.iter().take(DEPTH).enumerate() {
            let sibling = idx ^ 1;
            siblings.push(nodes.get(sibling).copied().unwrap_or(self.zeros[level]));
            idx /= 2;
        }
        MerklePath {
            leaf_index,
            siblings,
            root: self.root,
        }
    }
}

/// Recompute a root from a leaf and its path — the native mirror of the in-circuit membership check.
pub fn root_from_path(cfg: &PoseidonConfig<Fr>, leaf: Fr, path: &MerklePath) -> Fr {
    let mut cur = leaf;
    let mut idx = path.leaf_index;
    for sibling in &path.siblings {
        cur = if idx.is_multiple_of(2) {
            poseidon_hash2(cfg, cur, *sibling)
        } else {
            poseidon_hash2(cfg, *sibling, cur)
        };
        idx /= 2;
    }
    cur
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon_config;

    fn leaf(i: u64) -> Fr {
        Fr::from(1000 + i)
    }

    #[test]
    fn empty_root_is_the_zero_subtree() {
        let cfg = poseidon_config::<Fr>();
        let t = MerkleTree::new(&cfg);
        assert_eq!(t.root(), zero_hashes(&cfg)[DEPTH]);
        assert_eq!(t.next_index(), 0);
    }

    /// The incremental root and the root recomputed from every membership path must agree — this is
    /// the invariant that lets the contract store only a root while wallets prove against paths.
    #[test]
    fn paths_reproduce_the_incremental_root() {
        let cfg = poseidon_config::<Fr>();
        let mut t = MerkleTree::new(&cfg);
        for i in 0..9 {
            t.insert(leaf(i));
        }
        for i in 0..9 {
            let p = t.path(i);
            assert_eq!(p.siblings.len(), DEPTH);
            assert_eq!(
                root_from_path(&cfg, leaf(i), &p),
                t.root(),
                "path for leaf {i} must reproduce the root"
            );
        }
    }

    #[test]
    fn root_changes_on_every_insert() {
        let cfg = poseidon_config::<Fr>();
        let mut t = MerkleTree::new(&cfg);
        let mut seen = vec![t.root()];
        for i in 0..8 {
            t.insert(leaf(i));
            let r = t.root();
            assert!(!seen.contains(&r), "root repeated after insert {i}");
            seen.push(r);
        }
    }

    /// A path proves membership of *that* leaf only — swapping the leaf must not reproduce the root,
    /// or a forged note would pass the membership check.
    #[test]
    fn wrong_leaf_does_not_reproduce_the_root() {
        let cfg = poseidon_config::<Fr>();
        let mut t = MerkleTree::new(&cfg);
        for i in 0..5 {
            t.insert(leaf(i));
        }
        let p = t.path(2);
        assert_ne!(root_from_path(&cfg, leaf(99), &p), t.root());
    }
}
