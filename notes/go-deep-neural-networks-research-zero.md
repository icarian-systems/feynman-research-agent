# AlphaGo Zero & AlphaZero: Deep Research Notes

> **Sources:** Silver et al. (2017) *Nature* 550, 354–359 · Silver et al. (2018) *Science* 362(6419), 1140–1144  
> **Compiled:** 2026-05-20

---

## 1. AlphaGo Zero — "Mastering the Game of Go without Human Knowledge" (2017)

**Full citation:**  
Silver, D., Schrittwieser, J., Simonyan, K., Antonoglou, I., Huang, A., Guez, A., Hubert, T., Baker, L., Lai, M., Bolton, A., Chen, Y., Lillicrap, T., Hui, F., Sifre, L., van den Driessche, G., Graepel, T., & Hassabis, D. (2017). Mastering the game of Go without human knowledge. *Nature*, 550(7676), 354–359. https://doi.org/10.1038/nature24270

**Open-access preprint:** https://augmentingcognition.com/assets/Silver2017a.pdf  
**UCL repository:** https://discovery.ucl.ac.uk/id/eprint/10045895/  
**DeepMind blog:** https://deepmind.google/discover/blog/alphago-zero-starting-from-scratch/

---

### 1.1 The Core Innovation: Tabula Rasa Self-Play

AlphaGo Zero is the first Go program to achieve superhuman performance **without any human data, handcrafted features, or domain knowledge beyond the rules of the game**. All prior AlphaGo versions (Fan, Lee, Master) bootstrapped training from a large corpus of human professional games via supervised learning before applying RL refinement.

Key departures from AlphaGo Fan/Lee:

| Dimension | AlphaGo Fan/Lee | AlphaGo Zero |
|---|---|---|
| Starting point | SL on human pro games | Random weights |
| Input features | Hand-engineered features + board state | Raw board state only (black/white stones) |
| Network design | Separate policy + value networks | Single dual-head network |
| MCTS rollouts | Fast rollout policy (handcrafted) | None — NN evaluation only |
| Hardware | 176 GPUs / 48 TPUs (distributed) | 4 TPUs on a single machine |

The algorithm frames self-play as **policy iteration**: MCTS acts as a policy improvement operator (search probabilities π are stronger than raw network probabilities p), and the game outcome z acts as a policy evaluation signal. The network parameters θ are then updated to bring (p, v) = f_θ(s) closer to (π, z).

---

### 1.2 Architecture: Single Dual-Head Residual Network

AlphaGo Zero uses a single deep residual network f_θ(s) that jointly outputs:
- **Policy head:** a vector **p** of move probabilities over all legal moves (including pass)
- **Value head:** a scalar **v** ∈ (−1, +1) estimating win probability from the current position

**Network body (small / 3-day run):** 20 residual blocks  
**Network body (large / 40-day run):** 40 residual blocks

Each residual block consists of:
1. Conv layer (256 filters, 3×3 kernel, stride 1)
2. Batch normalization
3. ReLU
4. Conv layer (256 filters, 3×3 kernel, stride 1)
5. Batch normalization
6. Skip connection (residual addition)
7. ReLU

**Policy head:** additional conv layer → softmax over all 19×19 + 1 moves  
**Value head:** additional conv → fully connected (256 units, ReLU) → tanh scalar output

**Combined loss function:**
```
l = (z − v)²  −  πᵀ log p  +  c‖θ‖²
```
(MSE for value + cross-entropy for policy + L2 regularization)

**Architecture ablation study** (from Figure 4 of the paper): The paper compares four architectures—`dual-res` (AlphaGo Zero), `sep-res` (separate networks, residual), `dual-conv` (dual network, convolutional), `sep-conv` (AlphaGo Lee style):
- Switching from conv to residual: **+600 Elo**
- Switching from separate to dual (combined) networks: **another +600 Elo**

The dual objective also acts as a regularizer, forcing a shared representation that generalizes across both policy and value prediction tasks.

---

### 1.3 MCTS Without Rollouts

Prior AlphaGo MCTS used two evaluation mechanisms at leaf nodes: (1) the value network, and (2) a fast *rollout policy* (a lightweight hand-engineered network that rapidly plays out random games to terminal states). Positions were evaluated by blending these two signals.

**AlphaGo Zero eliminates rollouts entirely.** Leaf nodes are evaluated exclusively by the deep neural network. This is feasible because the trained network is high quality enough that its value estimates are more accurate than rollout-based estimates.

**MCTS procedure in AlphaGo Zero:**

Each MCTS simulation traverses from the root state downward by always selecting the action maximizing:
```
Q(s, a) + U(s, a)      where U(s, a) ∝ P(s, a) / (1 + N(s, a))
```
- **Q(s,a):** mean action value over all simulations through (s, a)  
- **U(s,a):** upper confidence bound proportional to prior P (from neural network) but discounted by visit count N
- **P(s,a):** prior probability from the neural network's policy head (PUCT formula)

At a leaf node s′, the network is evaluated **once** to get (P(s′, ·), V(s′)). The value V is backed up through the traversed path. After all simulations, the move-selection probabilities π are proportional to N(s, a)^(1/τ), where τ is a temperature parameter controlling exploration.

During the 3-day (20-block) training run, **1,600 simulations per MCTS** were used, corresponding to ~0.4 seconds per move.

---

### 1.4 Training Details and Timeline

#### 3-Day Run (20 Residual Blocks)

| Parameter | Value |
|---|---|
| Self-play games generated | 4.9 million |
| Simulations per MCTS | 1,600 |
| Thinking time per move | ~0.4 seconds |
| Minibatch size | 2,048 positions |
| Total minibatch updates | 700,000 |
| Hardware | 1 machine, 4 TPUs |
| Training duration | ~72 hours |

**Performance milestones (3-day run):**
- **36 hours:** AlphaGo Zero surpasses AlphaGo Lee on the Elo scale (via self-play metrics)
- **72 hours:** AlphaGo Zero defeats the *exact* AlphaGo Lee that beat Lee Sedol, **100 games to 0**, under 2-hour per game match conditions. AlphaGo Lee ran on 48 TPUs distributed; AlphaGo Zero used a single machine with 4 TPUs.

#### 40-Day Run (40 Residual Blocks)

| Parameter | Value |
|---|---|
| Self-play games generated | 29 million |
| Minibatch updates | 3.1 million (2,048 positions each) |
| Training duration | ~40 days |

**Final Elo ratings (5s per move):**

| System | Elo |
|---|---|
| AlphaGo Zero (40 blocks) | **5,185** |
| AlphaGo Master | 4,858 |
| AlphaGo Lee | 3,739 |
| AlphaGo Fan | 3,144 |
| Raw neural network (no MCTS) | 3,055 |
| Crazy Stone | ~1,000 |

A 200-point Elo gap corresponds to a 75% win probability. AlphaGo Zero's Elo advantage over AlphaGo Master (~327 points) implies it wins ~82% of games.

**Head-to-head match:** AlphaGo Zero (40-day) vs AlphaGo Master — **89 wins to 11** over 100 games at 2-hour time controls.

#### Supervised Learning Comparison

The paper also trained a second network with the same architecture on the KGS human expert dataset (supervised learning). The SL network:
- Achieved **higher initial move prediction accuracy** on professional games
- Was **surpassed by the self-play RL agent within 24 hours** of training

This demonstrates that RL self-play learns qualitatively different (and stronger) strategies than human imitation.

---

### 1.5 Knowledge Discovery

AlphaGo Zero independently rediscovered much of Go's classical strategic knowledge from scratch, including:
- Fuseki (opening theory)
- Joseki (corner sequences) — including the 3-3 invasion, later displaced by novel variants AlphaGo Zero invented
- Tesuji (tactical sequences)
- Life and death, ko fights, yose (endgame), shape, sente, influence, territory

Notably, **shicho** ("ladder" capture sequences — one of the earliest concepts humans learn) was not discovered until later in training. AlphaGo Zero also developed **new joseki variants** unknown in professional play.

---

## 2. AlphaZero — "A General Reinforcement Learning Algorithm that Masters Chess, Shogi, and Go through Self-Play" (2018)

**Full citation:**  
Silver, D., Hubert, T., Schrittwieser, J., Antonoglou, I., Lai, M., Guez, A., Lanctot, M., Sifre, L., Kumaran, D., Graepel, T., Lillicrap, T., Simonyan, K., & Hassabis, D. (2018). A general reinforcement learning algorithm that masters chess, shogi, and Go through self-play. *Science*, 362(6419), 1140–1144. https://doi.org/10.1126/science.aar6404

**Open-access preprint:** https://discovery.ucl.ac.uk/id/eprint/10069050/1/alphazero_preprint.pdf  
**Author copy:** https://www.davidsilver.uk/wp-content/uploads/2020/03/alphazero.pdf  
**Science journal page:** https://www.science.org/doi/10.1126/science.aar6404

---

### 2.1 Generalization to Chess and Shogi

AlphaZero applies the AlphaGo Zero algorithm to **chess** and **shogi** (Japanese chess) with no game-specific tuning beyond game rules. The same network architecture, loss function, and MCTS algorithm are used across all three games. This directly tests whether AlphaGo Zero's approach constitutes a *general* learning algorithm rather than a Go-specific one.

**Key adaptations for chess/shogi** (differences from AlphaGo Zero):

| Issue | AlphaGo Zero | AlphaZero |
|---|---|---|
| Outcome space | Binary win/loss | Win/draw/loss (draws supported) |
| Board symmetry | 8-fold rotation/reflection augmentation | No augmentation (chess/shogi are asymmetric) |
| Best-player selection | Yes — new network replaces old if it wins ≥55% | No — single network updated continuously |
| Hyperparameter tuning | Bayesian optimization per game | Same hyperparameters reused across all 3 games |

**Domain knowledge provided to AlphaZero** (minimal):
1. Game rules (for MCTS simulation and termination)
2. Board grid structure (NN architecture uses spatial planes)
3. Piece/move encoding (input/output planes based on rules)
4. Approximate number of legal moves (for scaling exploration noise)

No opening books, endgame tablebases, domain heuristics, or human game data were used.

---

### 2.2 Architecture in AlphaZero

AlphaZero uses the **same convolutional dual-head residual architecture** as AlphaGo Zero:

**Body:** A rectified batch-normalized conv layer followed by **19 residual blocks** (slightly fewer than AlphaGo Zero's 20/40), each with two conv layers (256 filters, 3×3, stride 1) + skip connection.

**Policy head:** Conv layer → game-specific output planes:
- Chess: 8×8×73 = 4,672 possible moves
- Shogi: 9×9×139 = 11,259 possible moves  
- Go: 19×19+1 = 362 moves (identical to AlphaGo Zero)

**Value head:** Conv (1 filter, 1×1) → FC (256 units, ReLU) → tanh scalar

**Input representation:** An N×N×(MT + L) image stack:
- T sets of M binary planes encoding piece positions at the last T timesteps
- L additional planes for special rules (castling legality, repetition count, move-count for 50-move rule in chess)

The loss function is identical to AlphaGo Zero (Equation 1 above).

---

### 2.3 Training Details

| Parameter | Chess | Shogi | Go |
|---|---|---|---|
| Training steps | 700,000 | 700,000 | 700,000 |
| Minibatch size | 4,096 | 4,096 | 4,096 |
| Wall-clock training time | ~9 hours | ~12 hours | ~13 days |
| MCTS simulations per move | 800 | 800 | 800 |
| Simulations needed to beat champion | 300k steps (~4h) | 110k steps (~2h) | 74k steps (~30h vs AlphaGo Lee) |

**Hardware:** 5,000 first-generation TPUs for self-play generation; 16 second-generation TPUs for network training.

**Learning rate schedule:** Starting at 0.2, dropped to 0.02 → 0.002 → 0.0002 at specified step milestones. Dirichlet noise added to root priors for exploration (α = 0.3 chess, 0.15 shogi, 0.03 Go — inversely proportional to typical number of legal moves).

---

### 2.4 Performance Comparisons

#### Chess: AlphaZero vs. Stockfish 8

Stockfish 8 was the 2016 TCEC (Top Chess Engine Championship) world champion, configured for the match with:
- 44 CPU cores (two 2.2GHz Intel Xeon Broadwell CPUs)
- 32GB hash table
- Syzygy endgame tablebases
- 3-hour time controls + 15 seconds per move

AlphaZero searched only **~60,000 positions per second** vs. **~60 million** for Stockfish (1,000× fewer evaluations).

**Match results (1,000 games at 3-hour time controls):**

| Result | Count |
|---|---|
| AlphaZero wins | 155 |
| Draws | 839 |
| AlphaZero losses | 6 |

AlphaZero won 25.5× more games than it lost. It also defeated Stockfish starting from all major human opening systems, Stockfish 9 (newest version at time of writing), and Stockfish with the Brainfish opening book.

**Time-advantage ablation:** AlphaZero still won against Stockfish when given only 1/10th of Stockfish's thinking time (searching ~1/10,000th as many positions).

**Chess.com summary of the published match:** https://www.chess.com/news/view/updated-alphazero-crushes-stockfish-in-new-1-000-game-match  
**Game database (original 2017 match, 10 games):** https://www.chessgames.com/perl/chess.pl?tid=91944

---

#### Shogi: AlphaZero vs. Elmo

Elmo (combined with YaneuraOu) was the 2017 CSA (Computer Shogi Association) world champion.

**Match results:**
- AlphaZero playing Black (first mover): **98.2% win rate**
- AlphaZero overall: **91.2% win rate**
- AlphaZero also won under CSA world championship time controls (10 min + 10 sec/move)
- AlphaZero won against Aperyqhapaq (another top shogi engine) by a large margin

Search rate: AlphaZero evaluated ~60,000 positions/second vs ~25 million for Elmo (~400× fewer evaluations).

---

#### Go: AlphaZero vs. AlphaGo Zero (3-day, 20-block version)

- **AlphaZero won 61% of games** against the previously published AlphaGo Zero trained for 700,000 steps (3 days)
- Note: AlphaGo Zero exploited 8-fold board symmetry to generate 8× more training data per position; AlphaZero does not assume symmetry

This result is significant: a *general* algorithm with no Go-specific symmetry augmentation can recover nearly equivalent performance to a Go-specific design.

**Learning speed comparison (time to surpass baselines):**

| Game | Baseline surpassed | Steps | Wall-clock time |
|---|---|---|---|
| Chess | Stockfish 8 | 300,000 | ~4 hours |
| Shogi | Elmo | 110,000 | ~2 hours |
| Go | AlphaGo Lee | 74,000 | ~30 hours |

---

### 2.5 Why MCTS + Neural Network Outperforms Alpha-Beta Search

Stockfish and Elmo use **alpha-beta search** with handcrafted evaluation functions. AlphaZero challenges the long-held belief that alpha-beta is inherently superior for these domains.

Key differences in approach:

| Dimension | Stockfish/Elmo | AlphaZero |
|---|---|---|
| Evaluation function | Handcrafted linear combination of features | Deep NN (non-linear) |
| Search | Alpha-beta with domain heuristics (null-move pruning, aspiration windows, history heuristic, SEE, etc.) | MCTS with neural network-guided selection |
| Error handling | Minimax propagates biggest errors to root | MCTS averages over subtree evaluations (errors tend to cancel) |
| Opening book | Yes (carefully tuned) | No |
| Endgame tablebase | Yes (Syzygy) | No |
| Positions/second | 60M (Stockfish) | 60K (AlphaZero) |

The paper speculates that MCTS's averaging of neural network evaluations across subtrees allows approximation errors to cancel, whereas alpha-beta's minimax tends to propagate worst-case errors to the root.

---

## 3. The Algorithmic Lineage: From AlphaGo to AlphaZero

```
AlphaGo Fan (2015)
  └─ SL policy network + RL policy network + value network + rollout policy
  └─ Defeated Fan Hui (European champion, 5-0)
  └─ Separate policy/value networks; SL initialized

AlphaGo Lee (2016)  
  └─ Same architecture, larger networks (12 conv layers × 256 planes)
  └─ Defeated Lee Sedol 4-1 (March 2016)
  └─ 48 TPUs distributed

AlphaGo Master (2017, unpublished)
  └─ Same algorithm as AlphaGo Zero but with human features + rollouts
  └─ Defeated top professionals 60-0 in online games (January 2017)
  └─ Elo: 4,858

AlphaGo Zero (2017)  ← Nature paper
  └─ NO human data, NO rollouts, single dual-head residual net
  └─ 3-day version (20 blocks): defeated AlphaGo Lee 100-0 in 72h
  └─ 40-day version (40 blocks): Elo 5,185, defeated AlphaGo Master 89-11

AlphaZero (2018)  ← Science paper
  └─ Same as AlphaGo Zero, generalized to chess + shogi
  └─ No symmetry augmentation, continuous network updates, handles draws
  └─ Defeated Stockfish 8 (+155 -6 =839 / 1,000 games)
  └─ Defeated Elmo (91.2% win rate)
  └─ Defeated AlphaGo Zero 61% in Go
```

---

## 4. Significance and Implications

1. **Proof of tabula rasa RL at scale:** Both papers demonstrate that an agent can achieve superhuman performance in complex perfect-information games without any human expertise, given sufficient compute and the right inductive bias (convolutional architecture matched to the grid structure of board games).

2. **MCTS as a policy improvement operator:** The key insight is that MCTS, guided by the neural network, acts as a powerful policy improvement step — the search probabilities π are significantly stronger than the raw network probabilities p, providing high-quality training targets.

3. **Single network vs. two networks:** Combining policy and value in one network (with shared representation) outperforms separate networks by ~600 Elo, because the dual objective regularizes the shared body toward representations useful for both prediction tasks.

4. **Generality:** AlphaZero demonstrates that a single algorithm, using only the game rules and raw board state, can master three fundamentally different games (Go, chess, shogi), outperforming decades of domain-specific engineering in each case.

5. **Compute efficiency:** AlphaZero uses 1,000× fewer positions per second than Stockfish yet achieves superior play — highlighting that deep network guidance makes position *quality* matter far more than raw *quantity* of search.

6. **Broader impact:** The papers inspired subsequent work including MuZero (Silver et al., 2020), which removes even the requirement for known game rules by learning a model of the environment.

---

## 5. Sources

### Primary Sources (Kept)
- **Silver et al. (2017)** — AlphaGo Zero Nature paper. Full text: https://augmentingcognition.com/assets/Silver2017a.pdf | DOI: https://doi.org/10.1038/nature24270
- **Silver et al. (2018)** — AlphaZero Science paper preprint: https://discovery.ucl.ac.uk/id/eprint/10069050/1/alphazero_preprint.pdf | DOI: https://doi.org/10.1126/science.aar6404
- **DeepMind blog (2017)** — AlphaGo Zero: Starting from scratch: https://deepmind.google/discover/blog/alphago-zero-starting-from-scratch/

### Secondary Sources (Kept)
- **ar5iv rendering of AlphaZero arXiv preprint** (1712.01815) — Contains Figure 1 performance data with annotated timelines: https://ar5iv.labs.arxiv.org/html/1712.01815
- **Chess.com** — Updated AlphaZero vs. Stockfish 1,000-game match analysis: https://www.chess.com/news/view/updated-alphazero-crushes-stockfish-in-new-1-000-game-match
- **Chessgames.com** — Game database for original AlphaZero–Stockfish match (2017): https://www.chessgames.com/perl/chess.pl?tid=91944
- **Nature News (2017)** — "Self-taught AI is best yet at strategy game Go": https://www.nature.com/articles/nature.2017.22858

### Dropped
- JETIR Research Journal summary (2022) — Secondary, no primary data, adds nothing beyond the papers
- Chess Stack Exchange thread — Speculative discussion about current Stockfish vs. AlphaZero; not primary source

---

## 6. Gaps and Open Questions

1. **Exact search parameters for AlphaGo Lee match (3-day run):** The paper states AlphaGo Zero used "2h time controls" for the match against AlphaGo Lee; exact number of MCTS simulations per move under match conditions vs. training conditions is not fully specified for all conditions.

2. **AlphaGo Zero vs. AlphaZero on Go (direct):** The Science paper compares AlphaZero to the 3-day AlphaGo Zero; no published direct comparison to the 40-day AlphaGo Zero exists in these papers.

3. **Stockfish version fairness:** Some critics noted the original match used Stockfish 8 rather than 9, and that Stockfish was not given an opening book while AlphaZero benefited from self-play-discovered openings. The Science paper does address this with additional matches against Stockfish 9 and with opening book, with AlphaZero still winning convincingly.

4. **Current-generation Stockfish:** Post-2018, Stockfish adopted NNUE (efficiently updatable neural network) evaluation, dramatically closing the gap. Whether AlphaZero as published would beat modern Stockfish (16+) is contested (~100 Elo advantage estimated by some analysts, but conditions matter).

5. **MuZero (follow-up):** Silver et al. (2020) in *Nature* presents MuZero, which extends AlphaZero by also learning the game dynamics model (removing even the known-rules requirement). This is the natural next paper in the sequence.
