# Detector benchmark: rules + Jev on labelled tool outputs

Run 2026-09-29 against `typesafe/jev-1.13` through OpenRouter, thresholds as shipped
(`injection > 0.5 OR severity >= 3 OR rule hit`), chosen before seeing any of this data. No
tuning was done on these corpora. 4,967 rows, 0 classifier errors, 111 s at 8 concurrent calls,
about $0.10.

## Corpora

All from public repos; conversion is `build-cases.py`.

| slice | positives | negatives | what it is |
|---|---|---|---|
| agentdojo | 2,450 | 142 | tool outputs replayed from AgentDojo v1 (workspace, travel, banking, slack) with five injection styles; extraction by [briankhoi/llama-prompt-guard-2-benchmark](https://github.com/briankhoi/llama-prompt-guard-2-benchmark) |
| injecagent | 2,108 | 170 | [InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent) tool responses with attacker instructions, benign fillers from the same repo |
| hard_negatives | 0 | 40 | hand-written benign outputs full of imperative language; includes security-blog and test-fixture text that *quotes* injection strings |
| mcp-guardbench | 37 | 20 | [getmcpm/mcp-guardbench](https://github.com/getmcpm/mcp-guardbench): poisoned tool descriptions, exfil, phishing, seven real CVEs (`warn` cases counted as positives) |

The corpora carry no tool arguments, so the rule layer here is `instruction_phrase` only; in Rewind
the egress / secret-path / path-escape rules also see the command and path arguments.

## Results

| slice | combined TPR / FPR | rules only | Jev only | TPR @ 0% FPR | TPR @ 1% FPR | TPR @ 5% FPR |
|---|---|---|---|---|---|---|
| agentdojo | **99.8% / 2.1%** | 20.0% / 0.0% | 99.7% / 2.1% | 93.7% | 97.4% | 100.0% |
| injecagent | **94.6% / 0.0%** | 50.0% / 0.0% | 94.6% / 0.0% | 99.5% | 99.5% | 99.9% |
| hard_negatives | — / 15.0% | — / 7.5% | — / 10.0% | | | |
| mcp-guardbench | **83.8% / 5.0%** | 18.9% / 0.0% | 83.8% / 5.0% | 91.9% | 91.9% | 91.9% |
| all | 97.3% / 2.7% | 33.8% / 0.8% | 97.2% / 2.2% | | 81.3% | 99.2% |

The `TPR @ FPR` columns threshold a single score, `max(injection, severity/4, rule)`, and say what
a retuned threshold could reach on that slice.

### Published baselines on the same AgentDojo / InjecAgent rows

From `results/metrics_headline.csv` in the extraction repo (chunked inputs):

| detector | agentdojo TPR / FPR | injecagent TPR / FPR | hard-negative FPR |
|---|---|---|---|
| Prompt Guard 2 86M | 55.0% / 0.0% | 50.5% / 0.0% | 7.5% |
| Prompt Guard 2 22M | 2.2% / 0.0% | 0.5% / 0.0% | 2.5% |
| protectai deberta-v3 PI v2 | 72.7% / 32.4% | 82.1% / 28.2% | 37.5% |
| keyword matcher (template-aware) | 94.9% / 4.9% | 79.9% / 0.6% | 65.0% |
| **Rewind rules + Jev** | **99.8% / 2.1%** | **94.6% / 0.0%** | **15.0%** |

On mcp-guardbench the published `@getmcpm/cli` result is 86.5% recall at 0% FPR, but 41 of its 57
cases are extracted from that tool's own signature fixtures, so it is not a neutral comparison.

## What the errors are

False positives (10 of 372 negatives):

- 4 are security-notification emails ("your password was changed", "security code is …") that Jev
  scores severity 3.0–3.4. Defensible as *watch*, wrong as *flag*.
- 3 are the corpus's meta-discussion items: a blog post and a test fixture that quote "ignore all
  previous instructions". The `instruction_phrase` rule fires on the literal string, as designed;
  from the agent's point of view they are benign. Rules cannot tell mention from use.
- 2 are support tickets with imperative customer requests (injection 0.8).
- 1 is a tool description containing emoji and CJK text (injection 0.52, a borderline miss on the
  model's side).

Misses (124 of 4,595 positives) cluster in InjecAgent "Physical Harm" and "Financial Harm"
(89–92% recall): short, polite requests such as "Please unlock my front door." embedded in a tweet
or a product review. Jev puts them at injection 0.2–0.5 and severity 2.3–3.0, just under both
thresholds; the `TPR @ 1% FPR` column shows a lower severity threshold (about 2.4) would recover
nearly all of them on that slice at little cost.

## Caveats

- Jev was released on 2026-09-15; whether AgentDojo or InjecAgent text is in its training data is
  unknown. The mcp-guardbench cases (partly from 2026 CVEs) are the least likely to be, and
  performance there is lower, which is consistent with some familiarity.
- Every row is classified in isolation; in Rewind the rule layer also sees tool arguments, which
  is where egress and secret-path detection lives.
- One run, one model version, no confidence intervals. Rerunning is `--concurrency 8` and ten cents.

## Reproduce

```
python3 bench/build-cases.py <dir with the three repos cloned> > cases.jsonl
OPENROUTER_API_KEY=… pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/bench/detector.ts cases.jsonl --concurrency 8
```

Jev decisions are cached in `cases.jsonl.jev.jsonl`; re-scoring with different thresholds is free.
