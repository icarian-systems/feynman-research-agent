# Literature Review Plan: Mastering Go with Deep Neural Networks

**Slug:** `go-deep-neural-networks`  
**Date:** 2026-05-20  
**Status:** DRAFT — awaiting user confirmation

---

## 1. Scope & Research Questions

**Central question:** How have deep neural networks transformed computer Go, from initial breakthroughs to superhuman play and beyond?

**Sub-questions:**

| # | Question | Priority |
|---|----------|----------|
| Q1 | What architectural innovations (policy networks, value networks, residual towers) enabled the AlphaGo breakthrough? | HIGH |
| Q2 | How did the progression from AlphaGo → AlphaGo Zero → AlphaZero eliminate human knowledge dependency? | HIGH |
| Q3 | What role does Monte Carlo Tree Search (MCTS) play when combined with neural networks, and how has that integration evolved? | HIGH |
| Q4 | What training regimes (supervised learning from human games, self-play RL, curriculum) were used and how do they compare? | HIGH |
| Q5 | What open-source replications exist (Leela Zero, ELF OpenGo, KataGo) and what efficiency gains did they achieve? | MEDIUM |
| Q6 | What are the known weaknesses and adversarial vulnerabilities of superhuman Go agents? | MEDIUM |
| Q7 | What broader impact has this line of work had on RL, game-playing AI, and other domains? | MEDIUM |

## 2. Source Types & Search Strategy

| Source type | Targets |
|-------------|---------|
| **Core papers** | AlphaGo (Silver et al., Nature 2016), AlphaGo Zero (Silver et al., Nature 2017), AlphaZero (Silver et al., Science 2018) |
| **Open-source replications** | KataGo (Wu, 2019), ELF OpenGo (Tian et al., 2019), Leela Zero |
| **Pre-DNN baselines** | Coulom (2006) MCTS, Gelly & Silver (2011), Müller (2002) survey |
| **Adversarial robustness** | Wang et al. (2023) adversarial attacks on Go AIs |
| **Surveys & retrospectives** | Any survey papers on computer Go or game-playing AI post-2016 |
| **Web / repos** | DeepMind blog posts, GitHub repos for KataGo/Leela Zero, Wikipedia timeline |

**Time period:** 2006–2025 (MCTS origins through modern open-source engines)

## 3. Expected Sections

1. **Introduction** — Why Go was the "grand challenge"; complexity arguments
2. **Pre-Deep-Learning Foundations** — MCTS, UCB1, early pattern-based approaches
3. **AlphaGo: The Breakthrough** — Architecture, training pipeline, match results
4. **AlphaGo Zero & AlphaZero: Self-Play Mastery** — Removing human data, generalization
5. **Open-Source Replications & Efficiency** — Leela Zero, ELF OpenGo, KataGo
6. **Adversarial Vulnerabilities & Limitations** — Known failure modes
7. **Broader Impact** — Influence on RL, protein folding, other games
8. **Consensus, Disagreements & Open Questions**
9. **Recommended Next Reading**

## 4. Task Ledger

| Task | Assignee | Status |
|------|----------|--------|
| Gather core AlphaGo/Zero/AlphaZero paper details | researcher | TODO |
| Gather open-source replication papers (KataGo, ELF, Leela) | researcher | TODO |
| Gather adversarial/weakness papers | researcher | TODO |
| Gather pre-DNN MCTS foundations | researcher | TODO |
| Synthesize into draft | main | TODO |
| Add inline citations | verifier | TODO |
| Review draft for gaps | reviewer | TODO |
| Final delivery | main | TODO |

## 5. Verification Log

| Claim | Source(s) | Status |
|-------|-----------|--------|
| (to be populated during synthesis) | | |

## 6. Deliverables

- `outputs/go-deep-neural-networks.md` — final literature review
- `outputs/go-deep-neural-networks.provenance.md` — provenance record
- `outputs/.plans/go-deep-neural-networks.md` — this plan (updated throughout)
