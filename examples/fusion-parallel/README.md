# Parallel Fusion Combos

Fork(parallel-execution) examples: fusion combos whose panels are resolved
**at dispatch time** from the model tag index — multiple models from multiple
providers working simultaneously on one prompt, with a judge synthesizing the
final answer.

## What's here

| Combo                        | Category    | Panel | Notes                                          |
| ---------------------------- | ----------- | ----- | ---------------------------------------------- |
| `parallel-coders`            | `coder`     | 4     | Bench ≥ 80, tools required                     |
| `parallel-vision`            | `vision`    | 3     | Bench ≥ 85, vision required (item recognition) |
| `parallel-reasoning`         | `reasoning` | 4     | Bench ≥ 85, longer straggler grace             |
| `parallel-generalists`       | `chat`      | 3     | Bench ≥ 85                                     |
| `parallel-coders-restricted` | `coder`     | 3     | Explicit provider allowlist                    |

All panels use `perProvider: 1` — every panel member is a **different model
from a different provider**. A `size` larger than the number of qualifying
providers truncates (and logs) rather than padding with same-provider models.

## Import

```bash
bash examples/fusion-parallel/import.sh http://localhost:20128 "$OMNIROUTE_API_KEY"
```

## Use

Point any OpenAI-compatible client at the combo by name (model:
`parallel-coders`), or select it in the dashboard. Preview what a panel
resolves to right now:

```bash
curl "http://localhost:20128/api/models/tags?panel=true&category=coder&size=4&minBenchmark=80"
```

## Tuning

- **Quality floor**: raise `minBenchmark` (0–100) to keep weak models out.
- **Panel size**: `size` is clamped to `[2, 40]` (heap guard, issue #1905).
- **Judge**: unset `judgeModel` defaults to the first panel member; set a
  strong synthesizer explicitly for best results.
- **Provider control**: `providers` (allowlist) / `excludeProviders`.
- **Stragglers**: `fusionTuning.stragglerGraceMs` caps how long the panel
  waits for laggards after quorum; `panelHardTimeoutMs` is the absolute cap.

See `docs/guides/PARALLEL_EXECUTION.md` for the full guide, including the
admission (`chat_admission_busy`) and proxy-dispatcher tuning that keeps
concurrent agent traffic flowing.
