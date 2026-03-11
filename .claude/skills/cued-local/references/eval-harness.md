## Cued Local Skill Evals

Use this only when benchmarking or refining `cued-local`.

### Goals

- Test whether the skill triggers when message/contact search is needed.
- Measure whether SQL-first guidance improves answer quality over no skill.
- Compare minimal instructions vs query-rich instructions vs enrichment guidance.

### Variants

- `baseline`: no skill
- `minimal`: DB path + schema summary only
- `query_examples`: current `SKILL.md`
- `query_examples_plus_enrichment`: current `SKILL.md` plus explicit web-enrichment step

### Run Rules

- Use `sqlite3 -json ~/.cued/local.db "<query>"` as the primary interface.
- Prefer views first.
- Use bash only to verify or inspect fixture files, not as the main retrieval strategy.
- Keep each run in a clean context.
- Run variants against the same prompt set.
- Record pass/fail, trigger correctness, elapsed time, token usage, and number of SQL queries.

### Scoring

- `answer_correct`: returned the right contact, thread, or message set
- `trigger_correct`: used the skill when needed and stayed out of unrelated coding tasks
- `sql_first`: used SQL before falling back to shell parsing
- `evidence_quality`: cited the right rows, timestamps, handles, or participants
- `restraint`: summarized before dumping long raw history

### Why This Shape

Anthropic’s March 3, 2026 skill-creator update emphasizes evals, benchmark mode, parallel clean-context runs, comparator agents, and trigger-description tuning. Vercel’s benchmark showed SQL clearly outperforming bash for structured data queries, with bash most useful for verification rather than primary retrieval.

Sources:

- [Anthropic: Improving skill-creator](https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills)
- [Vercel: Testing if bash is all you need](https://vercel.com/blog/testing-if-bash-is-all-you-need)
