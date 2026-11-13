# Why review code locally, and why use a separate model for it

Audience: engineering leaders and the engineers who set up PRISM for a team. Status: research
summary, 2026-11-13.

"Local review" here means checks that run on the developer's machine before a change leaves it:
a secret scan before each commit, an AI code review before each push, and (planned) a review
before a coding agent says it is finished. This document collects the evidence for doing that,
explains why the reviewer should be a different model or at least a separate agent from the one
that wrote the code, and maps each technique to what PRISM ships.

**How to read the evidence.** Every factual claim links to its source, with the year and the
setting (company, benchmark, survey) so you can judge how far it carries to your team. Sources
are paraphrased. Where the evidence is weak, contested or from a vendor selling a fix, the text
says so. Statements marked **PRISM design reasoning** are our judgement, not findings. Section 6
lists the metrics that let you check the claims in your own data instead of trusting them.

## Summary for engineering leaders

- **"A bug costs 100x more in production" is folklore, not a law.** The largest test of the idea,
  171 projects, found no consistent rise in fix effort for issues fixed later. The case for local
  review rests on feedback speed and review attention instead. See [section 1.1](#11-cost-of-defects-by-stage-weaker-than-the-folklore).
- **Small, fast-feedback changes predict better delivery, and AI is pushing the other way.**
  DORA's 2024 survey estimated a 7.2% drop in delivery stability per 25% rise in AI adoption and
  suspected larger changelists. See [section 1.2](#12-fast-feedback-and-small-batches).
- **Human review mostly finds maintainability issues and builds shared understanding.** Studies
  at Microsoft and Google agree. Removing secrets, lint-level problems and obvious bugs before
  the PR lets reviewers spend their attention on design. See [section 1.3](#13-what-code-review-catches-and-what-wastes-reviewer-attention).
- **Code from AI assistants and agents ships known vulnerability classes at high rates.**
  Results range from about 40% of Copilot programs (2021) to 41% of working solutions from a 2026
  frontier model on a CVE benchmark. Working code and secure code are separate questions.
  See [section 1.4](#14-code-from-ai-assistants-and-agents).
- **A pushed secret is public at once and stays in history.** Public GitHub gained about 28.65
  million new hardcoded secrets in 2025, and leaked AWS keys have been abused within minutes.
  Rotation, not deletion, is the fix, so the cheap moment is before the commit. See [section 1.5](#15-secrets).
- **The author model is a poor judge of its own work.** Self-correction without outside feedback
  often fails, and LLM judges favour their own outputs. A separate reviewer with fresh context,
  backed by deterministic tools, does better. See [section 2.1](#21-why-not-let-the-author-model-review-itself).
- **Local review is a filter, never the gate.** AI reviewers are noisy and non-deterministic, so
  keep CI gates and human approval. PRISM's local review never blocks a push; its CI gate and
  branch protection do the enforcing. See [section 3](#3-limits-and-risks).
- **It is cheap.** For one developer on this repository over 13 days, local review cost about $3
  of about $602 in AI spend (well under 1%) and added a median 11 seconds to a push. See
  [section 5](#5-what-it-costs-one-developers-numbers).
- **Measure it.** PRISM already records lead time, change failure rate, review verdicts,
  reverted AI commits, eval-gate findings per PR and secrets caught in CI. See [section 6](#6-what-to-measure).

## 1. Why local review helps PR quality

### 1.1 Cost of defects by stage: weaker than the folklore

The usual argument for "shift left" is that defects get much more expensive the later you find
them. The primary sources are thinner than the slide decks suggest.

| Source | What it says | How much weight it carries |
|---|---|---|
| [Boehm and Basili, *Software Defect Reduction Top 10 List*, IEEE Computer, 2001](https://www.cs.umd.edu/users/basili/publications/journals/J81.pdf) | Fixing a problem after delivery is often about 100 times more expensive than during requirements and design; for small, noncritical systems the ratio is closer to 5:1 | A two-page expert summary of 1970s-1990s data, mostly large, phase-gated projects. The authors themselves give the 5:1 caveat |
| [Menzies et al., *Are delayed issues harder to resolve?*, Empirical Software Engineering 22(4), 2017](https://arxiv.org/abs/1609.04886) | Tested the "delayed issue effect" in 171 projects (2006-2014) and found no consistent or substantial increase in effort to resolve issues found in later phases | The largest direct test of the claim. All projects used the Team Software Process (TSP); the authors argue TSP monitors work rather than removing the effect, but it limits how far the result carries |
| [Bossavit, *The Leprechauns of Software Engineering*, 2012-2015](https://leanpub.com/leprechauns), and his [notes on the "IBM Systems Science Institute" figures](https://gist.github.com/Morendil/ebfa32d10528af04e2ccb8995e3cb4a7) | Traces the widely copied 1x/6.5x/15x/100x chart to an internal IBM training course with no published data behind it; most citations are second-hand | A careful critique of the citation trail, not a new measurement. [The Register summarised it in 2021](https://www.theregister.com/software/2021/07/22/everyone-cites-that-bugs-are-100x-more-expensive-to-fix-in-production-research-but-the-study-might-not-even-exist/1371906) |

**What follows for this document.** We do not claim a cost multiplier. The case for local review
rests on three better-supported effects instead: feedback arrives while the author still has the
context (section 1.2), human reviewers stop spending attention on things a tool can find (1.3),
and some defects, such as a leaked credential, are cheap only before they leave the machine
(1.5).

### 1.2 Fast feedback and small batches

DORA's research program (Google Cloud, annual surveys of practitioners since 2014) is the most
cited evidence on delivery practices. It is survey-based and correlational, so read it as
"teams that do X tend to report Y", not as a controlled experiment.

- **Small batches.** DORA lists [working in small batches](https://dora.dev/capabilities/working-in-small-batches/)
  as a capability that predicts delivery and organizational performance. The page says small
  batches shorten the time to feedback and now describes them as a counterweight to the
  instability that AI adoption tends to bring, because large AI-generated changes are hard to
  review, test and integrate safely.
- **AI and stability.** The [2024 Accelerate State of DevOps report](https://dora.dev/research/2024/dora-report/2024-dora-accelerate-state-of-devops-report.pdf)
  (DORA, 2024, a survey of nearly 3,000 professionals) estimated that every 25% increase in AI adoption went
  with a 1.5% drop in delivery throughput and a 7.2% drop in delivery stability, even though
  AI improved process measures such as code review speed. The authors' hypothesis, not a
  measured result, is that AI lets people produce larger changelists, and DORA has long found
  larger changes slower and more failure-prone.

Local review helps here in a narrow but concrete way. A pre-push review returns findings in
minutes, on the author's machine, while the change is still small and fresh. A finding that
arrives in CI or from a human reviewer a day later costs a context switch and often another
review round. **PRISM design reasoning:** we expect the main gain to show up as fewer review
rounds and less rework per PR, not as fewer production incidents, and section 6 says how to
check that.

### 1.3 What code review catches, and what wastes reviewer attention

| Study | Setting | Finding |
|---|---|---|
| [Bacchelli and Bird, *Expectations, Outcomes, and Challenges of Modern Code Review*, ICSE 2013](https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/) | Microsoft: observation, interviews, surveys and hundreds of manually classified review comments | Finding defects is the main motivation for review, but reviews turn out to be less about defects than expected. They give knowledge transfer, team awareness and alternative solutions. Understanding the change is the reviewer's hardest task |
| [Mäntylä and Lassenius, *What Types of Defects Are Really Discovered in Code Reviews?*, IEEE TSE 35(3), 2009](https://lassenius.wordpress.com/publications/) | Nine industrial and 23 student reviews | About three quarters of the defects found affect evolvability (structure, naming, documentation) rather than visible function ([summary in Mäntylä's later work](https://mmantyla.github.io/Mantyla+Empirical+CameraReady.pdf)) |
| [Czerwonka, Greiler and Tilford, *Code Reviews Do Not Find Bugs*, ICSE SEIP 2015](https://www.microsoft.com/en-us/research/publication/code-reviews-do-not-find-bugs-how-the-current-code-review-best-practice-slows-us-down/) | Microsoft, experience plus review data | Reviews often do not find the functional issues that should block a submission, review is often the longest step of integration, and its cost justifies applying it more precisely |
| [Sadowski et al., *Modern Code Review: A Case Study at Google*, ICSE SEIP 2018](https://research.google/pubs/modern-code-review-a-case-study-at-google/) ([PDF](https://sback.it/publications/icse2018seip.pdf)) | Google: 12 interviews, 44 survey responses, logs of 9 million reviewed changes | Changes are small (median 24 lines; about 90% touch fewer than 10 files). Median time to first feedback is under an hour for small changes and about 5 hours for very large ones; median overall review latency is under 4 hours. Besides finding defects, motivations include education, maintaining norms and gatekeeping |
| [SmartBear, *Best Kept Secrets of Peer Code Review*, Cisco case study, 2006](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/) | One Cisco team, about 2,500 reviews | Recommends reviewing at most 200-400 lines at a time, because defect-finding falls beyond that. Widely cited, but a vendor study of one team that has not been replicated independently, so treat the exact thresholds as a rule of thumb |

**The connection to local review.** Reviewer attention is the scarce resource, it goes furthest
on small changes, and its best use is understanding and design. Every secret, unused variable,
missing error check or obvious null dereference that a human has to point out spends that
attention on something a tool could have found. Google's experience with static analysis points
the same way: [Tricorder](https://petertsehsun.github.io/soen7481/papers/tricoder.pdf) (Sadowski
et al., ICSE 2015) shows analysis results at review time, only on changed lines, and keeps the
"effective false positive" rate under 10%, because developers ignore noisy tools
([CACM 2018](https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/)).
Local review moves that cleanup one step earlier, before a reviewer is even assigned.

### 1.4 Code from AI assistants and agents

Studies of AI-generated code agree on the direction (known vulnerability classes appear often)
but vary widely in rate, because they use different tasks, models and definitions.

| Study | Date and setting | Finding |
|---|---|---|
| [Pearce et al., *Asleep at the Keyboard?*, IEEE S&P 2022](https://arxiv.org/abs/2108.09293) | 2021, GitHub Copilot on 89 scenarios built around MITRE Top 25 CWEs | About 40% of 1,689 generated programs were vulnerable |
| [Perry et al., *Do Users Write More Insecure Code with AI Assistants?*, ACM CCS 2023](https://arxiv.org/abs/2211.03622) | 2022, user study, codex-davinci-002 | Participants with the assistant wrote less secure code and were more likely to believe it was secure |
| [Veracode, *2025 GenAI Code Security Report*](https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report) ([blog](https://www.veracode.com/blog/genai-code-security-report)) | 2025, vendor study, 80 tasks across more than 100 models | 45% of samples failed security tests; newer or larger models did not do clearly better on security. Vendor report |
| [Vero et al., *BaxBench*, ICML 2025](https://arxiv.org/abs/2502.11844) | 2025, 392 backend tasks, end-to-end exploits | The best model reached 62% correctness; exploits succeeded on about half of the correct programs |
| [Semgrep, *Testing Claude Opus 5.5 on SusVibes*](https://semgrep.dev/blog/2026/claude-opus-5-5-susvibes-benchmark) | September 2026, vendor run, 186 tasks rebuilt from real Python CVEs | 93.5% of solutions worked, 54.8% worked and were secure, so 41% of working solutions kept the original vulnerability. Cryptography, concurrency and access-control tasks had no secure solutions. Semgrep notes much of the secure share came from memorised public fixes |
| [DryRun Security, *Agentic Coding Security Report*, as summarised by Help Net Security](https://www.helpnetsecurity.com/2026/03/13/claude-code-openai-codex-google-gemini-ai-coding-agent-security/) | March 2026, vendor study, three coding agents building two apps through PRs | 26 of 30 agent PRs (87%) had at least one vulnerability. Cited via [Provectus, 2026](https://provectus.com/blog/shift-left-security-scanning-with-claude-code-semgrep/); we did not read the primary report |
| [GitClear, *AI Copilot Code Quality*, 2025](https://www.gitclear.com/ai_assistant_code_quality_2025_research) | 211 million changed lines, 2020-2024 | Moved (refactored) lines fell from about 25% of changes in 2021 to under 10% in 2024, while copy/pasted lines rose from 8.3% to 12.3%. Correlational: it tracks the period of AI adoption, not AI authorship per line. Vendor report |

**What this implies for PRs from agents.** Agent-authored PRs tend to be larger, they pass their
own tests (Semgrep found working code almost always), and the author is often not watching the
code being written. The Perry study adds a human factor: people trust assistant output more than
they should. So "the tests pass" is not evidence of security, and a reviewer of an agent PR is
facing more code with more known-class defects. A local review step that catches those classes
before the PR opens is cheap insurance, provided it does not replace the human and CI checks that
catch what it misses (section 3).

### 1.5 Secrets

| Source | Finding |
|---|---|
| [GitGuardian, *State of Secrets Sprawl 2026*](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/) ([report](https://www.gitguardian.com/state-of-secrets-sprawl)) | 28.65 million new hardcoded secrets in public GitHub commits in 2025, up 34% on 2024. AI-service secrets rose 81%. Commits assisted by Claude Code leaked secrets at 3.2% against a 1.5% baseline, which GitGuardian itself frames as a workflow problem rather than a tool defect. More than 64% of secrets confirmed valid in 2022 were still valid in January 2026. Vendor report |
| [Meli, McNiece and Reaves, *How Bad Can It Git?*, NDSS 2019](https://www.ndss-symposium.org/wp-content/uploads/2019/02/ndss2019_04B-3_Meli_paper.pdf) | Six months of public commits plus a snapshot of 13% of public repos: leakage in over 100,000 repos and thousands of new secrets a day. 81% of detected secrets were never removed, and removing them in a new commit leaves them in git history |
| [Palo Alto Networks Unit 42, *EleKtra-Leak*, 2023](https://unit42.paloaltonetworks.com/malicious-operations-of-exposed-iam-keys-cryptojacking/) | In a honeypot test, an attacker found and used AWS IAM keys within five minutes of their exposure on GitHub |
| [GitHub Docs, *Removing sensitive data from a repository*](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) | For a leaked credential the first step is to revoke or rotate it. Rewriting history is disruptive and does not reach existing clones, forks or cached views. GitHub recommends a pre-commit hook such as gitleaks |

**Why before the commit.** Once a secret is pushed, deleting it does not help: it is in the
history and in every clone, and automated harvesters may already have it. The remedy is
rotation, which means finding every place the credential is used. A pre-commit scan costs
seconds and catches the secret while it exists only in the working tree. A CI scan still matters
as the backstop, but it fires after the secret has reached the remote. This is the one place
where the "earlier is cheaper" argument holds without needing a cost curve.

## 2. Reviewing with a separate model and an agent harness

A coding agent can be told "review your work before you finish". The evidence below says that
on its own this is weak, and suggests what to do instead.

### 2.1 Why not let the author model review itself

| Source | Finding | Caveat |
|---|---|---|
| [Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet*, ICLR 2024](https://arxiv.org/abs/2310.01798) | Without external feedback, models struggle to correct their own reasoning and sometimes get worse after "self-correction" | Reasoning benchmarks, 2023 models |
| [Kamoi et al., *When Can LLMs Actually Correct Their Own Mistakes?*, TACL 2024](https://arxiv.org/abs/2406.01297) | A critical survey: no prior work shows reliable self-correction from prompted self-feedback, except on tasks unusually suited to it. Self-correction works when there is reliable external feedback | Survey; the strongest summary of the area |
| [Stechly, Valmeekam and Kambhampati, *On the Self-Verification Limitations of LLMs*, 2024](https://arxiv.org/abs/2402.08115) | GPT-4 critiquing its own plans caused performance to collapse; a sound external verifier gave large gains | Planning and puzzle tasks |
| [Madaan et al., *Self-Refine*, NeurIPS 2023](https://arxiv.org/abs/2303.17651) | Same-model feedback and refinement improved outputs by about 20% absolute on average across 7 tasks | The counterpoint. Gains were largest on open-ended tasks such as dialogue; Huang et al. and Kamoi et al. question how far it extends to correctness |
| [Shinn et al., *Reflexion*, NeurIPS 2023](https://arxiv.org/abs/2303.11366) | Agents that reflect on feedback reached 91% pass@1 on HumanEval | The feedback came from executing tests, which is external, not self-judgement |
| [Zheng et al., *Judging LLM-as-a-Judge*, NeurIPS 2023](https://arxiv.org/abs/2306.05685) | Strong LLM judges agree with humans over 80% of the time, but show position, verbosity and self-enhancement biases | Chat quality, not code |
| [Panickssery, Bowman and Feng, *LLM Evaluators Recognize and Favor Their Own Generations*, NeurIPS 2024](https://arxiv.org/abs/2404.13076) | Models can recognise their own outputs, and the stronger that recognition, the stronger the preference for their own outputs | Summarisation tasks |
| [McAleese et al., *LLM Critics Help Catch LLM Bugs* (CriticGPT), OpenAI, 2024](https://arxiv.org/abs/2407.00215) ([blog](https://openai.com/index/finding-gpt4s-mistakes-with-gpt-4/)) | A separately trained critic caught more bugs in model-written code than paid human reviewers, and its critiques were preferred 63% of the time. Critics also hallucinate bugs; human plus critic teams hallucinated less than the critic alone | Trained critic, not an off-the-shelf model |
| [Du et al., *Multiagent Debate*, 2023](https://arxiv.org/abs/2305.14325) | Several model instances debating improved reasoning and factual accuracy | Costs several calls per answer |
| [Cobbe et al., *Training Verifiers to Solve Math Word Problems*, 2021](https://arxiv.org/abs/2110.14168) | Generating many candidates and letting a separate verifier pick improved results, and scaled better than fine-tuning alone | The origin of the generator-verifier pattern |

**What this adds up to.** Three points are well supported. Outside feedback (tests, analyzers,
a different reviewer) beats self-critique. A reviewer that shares the author's context and
weights is biased toward the author's output. A critic helps most when paired with a human, not
in place of one. Whether a *different model family* beats the *same model with fresh context*
for code review has not, to our knowledge, been measured directly; the self-preference results
suggest it helps, and **PRISM design reasoning** is to make the reviewer configurable so a team
can pick a different family.

### 2.2 Techniques

| Technique | Why | Support |
|---|---|---|
| Deterministic tools first, the model second | Secret scanners, linters and tests are cheap, repeatable and never hallucinate. Let the model judge only what they cannot | Kamoi et al. and Stechly et al. on external feedback; Semgrep found raw agent security review [noisy and non-deterministic](https://semgrep.dev/blog/2025/finding-vulnerabilities-in-modern-web-apps-using-claude-code-and-openai-codex/) (2025); [Provectus](https://provectus.com/blog/shift-left-security-scanning-with-claude-code-semgrep/) uses Semgrep as the deterministic anchor |
| A separate process with fresh context | The reviewer sees the diff and the rules, not the author's reasoning, so it cannot inherit the author's assumptions | Self-preference results above; PRISM design reasoning |
| A different model family or size | Reduces shared blind spots and self-preference. A smaller, faster model may be enough for a diff review | Panickssery et al.; [Anthropic](https://www.anthropic.com/engineering/building-effective-agents) suggests routing easy work to smaller models. Not measured directly for code review |
| Rules in a steering or rubric file | The reviewer applies the team's standards, not its own taste, and the same file drives local and CI review | Zheng et al. on judge biases; Anthropic's evaluator-optimizer pattern needs clear evaluation criteria |
| Structured output with a schema | A JSON verdict (findings with file, line, severity) can be parsed, counted, gated and compared over time | Common practice; [CodeRabbit agent mode](https://docs.coderabbit.ai/cli/agent-mode) emits JSON for agents to consume |
| Read-only reviewer | The reviewer may read surrounding code but never edit or run anything, so a bad review cannot change the change | Least privilege; PRISM design reasoning |
| Bounded fix rounds | The fix loop stops after a small number of rounds (PRISM uses 2) and hands the rest to a human, so an agent cannot loop forever chasing a noisy reviewer | [Anthropic](https://www.anthropic.com/engineering/building-effective-agents) recommends stopping conditions such as a maximum number of iterations; Claude Code and Cursor build in caps (below) |
| Treat findings as untrusted data | Review text quotes the code, and code can carry prompt injection. A finding is a pointer to read, never an instruction to follow | [Greshake et al., 2023](https://arxiv.org/abs/2302.12173) on indirect prompt injection; [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) |
| Enforce with hooks, not instructions | A hook on the agent's stop event or on `git push` runs whether or not the model remembers; an MCP tool plus "please call it" is advice | [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Cursor hooks](https://cursor.com/docs/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks); [Semgrep Guardian](https://semgrep.dev/guardian/) makes the same point |
| Control cost | Skip docs-only diffs, cache the verdict by diff hash, cap the diff size, use a smaller model | PRISM design reasoning; the Semgrep 2025 study spent $114 on agent scans of 11 apps, so whole-repo scans add up while diff reviews stay small |

**How the hooks differ by client.** In Claude Code, a `Stop` hook can block the agent from
finishing and send it a reason; its input has `stop_hook_active` so a hook can tell it is already
in a continuation, and Claude Code ends the turn after eight consecutive continuations (the cap is
configurable) ([docs](https://code.claude.com/docs/en/hooks)). Cursor's `stop` hook returns a
`followup_message` and counts rounds in `loop_count`, with a default `loop_limit` of 5; its
`failClosed` option decides whether a crashing hook blocks or allows
([docs](https://cursor.com/docs/hooks)). Codex has `PreToolUse` and `Stop` hooks in the same
family ([docs](https://learn.chatgpt.com/docs/hooks)). An MCP server with instructions in a
rules file works in every client but is advisory: the model decides whether to call it.

### 2.3 How vendors do it

| Product | Mechanism | Enforced or advisory |
|---|---|---|
| [Snyk Claude Code plugin](https://github.com/snyk/claude-plugin-snyk) | Background scans on each file edit; at the end of a response a hook checks newly written lines and blocks Claude from stopping with a table of issues to fix | Enforced (Stop hook) |
| [Semgrep Guardian](https://github.com/semgrep/guardian) ([docs](https://www.semgrep.dev/docs/guardian)) | MCP server, hooks and skills in one plugin; a post-write hook scans every file the agent writes with Semgrep Code, Supply Chain and Secrets. Claude Code and Codex | Enforced scan on write; fixing depends on the agent |
| [SonarQube plugin for Claude Code](https://www.sonarsource.com/blog/now-available-sonarqube-plugin-for-claude-code/) ([setup](https://www.sonarsource.com/developers/blueprints/set-up-the-sonarqube-plugin-for-claude-code/)) | MCP server, agentic analysis hooks, and secret-pattern blocking before content reaches the model | Hooks plus advisory MCP |
| [CodeRabbit CLI](https://www.coderabbit.ai/cli) ([agent mode](https://docs.coderabbit.ai/cli/agent-mode)) | `coderabbit review --agent` reviews local changes and emits JSON lines for an agent to act on; a separate review service, not the author model | Advisory unless wired to a hook |
| [Provectus reference setup](https://provectus.com/blog/shift-left-security-scanning-with-claude-code-semgrep/) (2026) | Claude Code with Semgrep via MCP and a post-write hook for the inner loop; Semgrep in CI as the enforcement gate | The local loop assists; CI enforces |

The common pattern: a deterministic engine or a separate review service, triggered by a hook,
with CI kept as the gate.

### 2.4 How PRISM does it

Everything in this table is on `main` unless marked planned.

| Technique | In PRISM | Where |
|---|---|---|
| Secrets before commit | Codewatch `pre-commit` runs `gitleaks protect --staged` and blocks the commit on a finding | [Codewatch](../USER_GUIDE.md#what-the-hooks-do) |
| Separate reviewer process, read-only | Codewatch `pre-push` runs a headless reviewer in its own process with only the diff and the rules. Claude Code gets `Read`, `Grep` and `Glob` and is denied `Bash`, `Edit`, `Write` and web tools; kiro-cli trusts only `fs_read` | [Choosing the Reviewer](../USER_GUIDE.md#choosing-the-reviewer), `cli/src/codewatch/reviewers/` |
| Configurable reviewer and model | `--reviewer kiro\|claude`, `git config prism.reviewer`, and `eval.model` in `.prism/config.json`, so the reviewer can differ from the tool that wrote the code | [Choosing the Reviewer](../USER_GUIDE.md#choosing-the-reviewer) |
| Rules file shared with CI | `.prism/review/rules.md`; the CI gate copies it over `.kiro/steering/code-review.md` so local and CI reviews use the same rules | [CI](../USER_GUIDE.md#ci) |
| Structured verdict | Both reviewers must return one JSON object with findings (file, line, severity, rule), a score and a summary; results go to `.prism/results/` | [Results](../USER_GUIDE.md#results) |
| Cost and size limits | Lock files are left out of the diff, diffs over 200,000 characters are cut, the review times out after 300 seconds by default | [What the Hooks Do](../USER_GUIDE.md#what-the-hooks-do) |
| Local review never blocks | Findings, a missing reviewer, a crash or a timeout all let the push through; commits without a matching secret scan are recorded as skipped | [What the Hooks Do](../USER_GUIDE.md#what-the-hooks-do) |
| CI gate with its own model choice | The eval gate runs gitleaks first (never skipped, fail-closed), then kiro-cli with the model from `PRISM_REVIEW_MODEL` or the **base branch's** `eval.model`, so a PR cannot pick a weaker reviewer for itself. One retry only when the reply is not valid JSON; both unparseable fails closed. Fails on a high finding, a score under 0.82 or any secret | [Kiro-CLI Eval Gate](../USER_GUIDE.md#kiro-cli-eval-gate), [Secret Scanning](../USER_GUIDE.md#secret-scanning-gitleaks) |
| Gate made binding | Branch protection must name `eval-gate` as a required check; until then the gate is advisory | [Making the Gate Block Merges](../USER_GUIDE.md#making-the-gate-block-merges) |
| Fix loop, bounded, findings untrusted | Claude Code plugin `/prism:fix` and the Kiro Crew `prism-fix-findings` skill: fix real high and medium findings in at most 2 rounds, never push, never bypass hooks, treat finding text as data | [Claude Code plugin](../USER_GUIDE.md#claude-code-plugin), [Kiro Crew app](../USER_GUIDE.md#kiro-crew-app) |
| Findings where the developer works | Editor extension (Problems panel), MCP server, Claude Code plugin with a SessionStart summary, Kiro Crew page and digest | [Where PRISM shows up](../USER_GUIDE.md#where-prism-shows-up) |
| Enforced harness loop (planned) | One CLI engine behind client hooks: a push gate on `git push` (on by default with the plugin), an opt-in `Stop` finish gate, at most 2 fix rounds counted by the CLI rather than the prompt, judging only the lines this session changed, and tamper rules so a fix cannot pass by editing the checks | [Design: the harness loop, PR #92](https://github.com/aws-samples/sample-prism-d1-velocity/pull/92) |

Two gaps are worth naming. Today the fix loop is advisory: the `/prism:fix` command and the
`prism-fix-findings` skill are instructions the agent follows, and the plugin's only hook is
SessionStart. The harness-loop design moves the loop into hooks. And codewatch reviews at push
time, so an agent that finishes without pushing has not been reviewed yet; the planned finish
gate covers that case.

## 3. Limits and risks

| Risk | Evidence | How PRISM mitigates it |
|---|---|---|
| False positives and reviewer fatigue | Semgrep found 86% of Claude Code's security findings were false positives on 11 real apps ([2025](https://semgrep.dev/blog/2025/finding-vulnerabilities-in-modern-web-apps-using-claude-code-and-openai-codex/)); Google keeps tools under a 10% effective false positive rate because developers ignore noise ([Tricorder](https://petertsehsun.github.io/soen7481/papers/tricoder.pdf)) | Local review reports and never blocks; the fix skills tell the agent to verify each finding and leave false positives alone; rules live in a file the team tunes; gitleaks false positives go in `.gitleaks.toml` or a baseline. A diff review is narrower than a whole-repo hunt, which Semgrep's numbers came from |
| Non-determinism | The same prompt on the same code gave 3, 6 and 11 findings on three runs (Semgrep, 2025) | Treat one run as a sample, not a guarantee; keep deterministic checks (gitleaks, tests) as the parts that must pass. **PRISM design reasoning:** the planned harness caches verdicts by diff hash so an unchanged diff is not re-rolled |
| Hallucinated bugs and bad fixes | CriticGPT critics hallucinate bugs ([OpenAI, 2024](https://arxiv.org/abs/2407.00215)); Semgrep saw agent "fixes" that broke working code (2025) | Findings are pointers the agent must confirm in the code; at most 2 fix rounds; the human reviewer still sees the final diff |
| Over-reliance on AI review | Assistant users overrated the security of their code ([Perry et al.](https://arxiv.org/abs/2211.03622)); human plus critic beat critic alone (CriticGPT) | Local review is a pre-filter. The CI gate, branch protection and human approval stay in place, and the CI gate uses a model chosen on the base branch |
| Model cost and latency | Agent scans cost real money per run (Semgrep's 2025 study: $114 across 11 apps); a stop hook adds wait time to every finish | Review only the pushed diff, drop lock files, cap size and time, pick a smaller model with `eval.model`. The finish gate is opt-in until cost is measured. One developer's measured numbers are in [section 5](#5-what-it-costs-one-developers-numbers) |
| Prompt injection through the code under review | [Greshake et al.](https://arxiv.org/abs/2302.12173), [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) | Reviewer is read-only with no shell or web; MCP tools return finding text as JSON fields with size caps and tell the agent it is data; the fix skills forbid following instructions found in findings |
| Bypass | `git commit --no-verify` skips the pre-commit hook | The pre-push hook records commits with no matching secret scan; CI gitleaks scans the whole PR range and cannot be skipped |
| Benchmarks overstate or understate real code | Semgrep found over half of a 2026 model's secure solutions were memorised public fixes | Judge by your own repos' data (section 6), not by vendor benchmarks, this document's included |

## 4. What local review does not replace

Human review remains the place for design, intent and knowledge sharing, which the studies in
section 1.3 say is most of its value. CI remains the place for enforcement, because local hooks
can be skipped and local reviewers vary by machine. The aim is that a human reviewer opens a
smaller PR with the mechanical problems already gone.

## 5. What it costs: one developer's numbers

The worked example is one developer working on this repository with Kiro and Claude Code,
1-13 November 2026. These are one person's numbers, not a benchmark. They show the order of
magnitude, and section 5.4 shows how to get your own.

### 5.1 Measured

Spend comes from the codeburn usage cache on that machine for 2026-11-01 to 2026-11-13. Latency
and outcomes come from the codewatch pre-push review result files.

| What | Calls | Spend | Per call |
|---|---|---|---|
| All AI coding, every model | 1,663 | $602.07 | n/a |
| Authoring, almost all one large model | 1,538 | $599.09 | n/a |
| Local review via kiro-cli `--model auto` | 78 | $2.66 | about $0.03 |
| Test of a Claude Code reviewer with a small model (Claude Haiku 4.5 on Bedrock) | 33 | $0.31 | about $0.01 |

| Pre-push reviews (33 result files) | Value |
|---|---|
| Median duration | 11 s |
| Longest | 66 s |
| Reported findings | 11 |
| Clean | 7 |
| Skipped, all with reason "No changes against upstream" (a push with nothing new versus the upstream branch) | 15 |

**Result.** Local review was well under 1% of total AI spend (about $3 of about $602) and added
about 11 seconds to a typical push.

Two caveats. codeburn attributes spend by model, not by purpose, so the kiro-cli `auto` bucket
may include a few kiro-cli calls that were not reviews; treat $2.66 as an upper bound for review
spend. And the review result files do not record tokens, so the exact cost per review cannot be
computed; cost per call is the closest measure.

**Not included: the CI eval gate.** The gate runs kiro-cli in CI with the repository's
`KIRO_API_KEY`, so its spend lands on the account that owns that key, not in this developer's
codeburn numbers. To measure it, count the `prism.d1.eval` events (one per gate run that
produced a score, with `pr_number`, `eval.findings` and the model in `ai_context.model`) and read
the usage of the account behind `KIRO_API_KEY`. If you run a reviewer on Amazon Bedrock in CI
instead, tag it (for example with an application inference profile carrying a cost allocation
tag) and filter AWS Cost Explorer by that tag.

### 5.2 Estimating your own cost

Per review:

```text
cost per review ≈ (diff tokens + rules/steering tokens + prompt overhead) × input price
                + output tokens × output price
```

Per change: multiply by the reviews per PR (one per push that has a reviewable diff). With the
planned harness loop, multiply by at most 3: the first review plus at most 2 fix rounds.

**Worked example.** The token counts below are **assumptions** for illustration, not
measurements: a 400-line diff at about 6,000 tokens, 1,500 tokens of rules, 2,500 tokens of
prompt overhead and surrounding code the reviewer reads, so 10,000 input tokens, plus 1,000
output tokens. Prices are Anthropic's published per-million-token API rates as read on
2026-11-13 ([pricing page](https://platform.claude.com/docs/en/about-claude/pricing)): Claude
Haiku 4.5 at $1 input and $5 output, Claude Sonnet 5.5 at $2 input and $10 output. Prices on
[Amazon Bedrock](https://aws.amazon.com/bedrock/pricing/) can differ by region and endpoint
type, so use your own rates.

| Reviewer model | One review | Worst case with 2 fix rounds (3 reviews) |
|---|---|---|
| Claude Haiku 4.5 | 10,000 × $1/M + 1,000 × $5/M ≈ $0.015 | ≈ $0.045 |
| Claude Sonnet 5.5 | 10,000 × $2/M + 1,000 × $10/M ≈ $0.03 | ≈ $0.09 |

The same pricing page notes that Claude 4.7 and later models use a newer tokenizer that
produces roughly 30% more tokens for the same text, so count tokens with the model you plan to
use. The example lands near the measured per-call costs in section 5.1 ($0.01 and $0.03), but
that is a sanity check, not a validation of the assumed token counts.

### 5.3 Cost levers

| Lever | Effect | In PRISM |
|---|---|---|
| Small, fast reviewer model | Lower price per token and lower latency | `eval.model` in `.prism/config.json`; `PRISM_REVIEW_MODEL` for CI |
| Cache by diff hash | An unchanged diff is not reviewed twice | Planned in the harness loop ([PR #92](https://github.com/aws-samples/sample-prism-d1-velocity/pull/92)) |
| Skip docs-only and empty diffs | No model call when nothing reviewable changed | Codewatch on `main` skips a push with no diff against upstream; the docs-only skip (`harness.skip_paths`, default `*.md` and similar) is only proposed in the harness-loop design ([PR #92](https://github.com/aws-samples/sample-prism-d1-velocity/pull/92)). All 15 skipped pushes in section 5.1 were pushes with no changes against upstream |
| Finish gate opt-in | No review on every agent turn unless the team turns it on | `harness.finish_gate`, off by default in the harness-loop design |
| Block only on secrets and high findings | Fewer fix rounds spent on low-severity advice | Planned `harness.block_on`, default `["secret", "high"]`. Local review on `main` never blocks; the CI gate fails on a secret, a high finding or a score under 0.82 |

### 5.4 Reproduce the numbers on your machine

- **Spend by model:** `prism-cli dashboard`, Usage panel, top models ([Panels](../USER_GUIDE.md#panels)).
  The same numbers come from codeburn directly: `codeburn report` for the interactive view,
  `codeburn export` for CSV or JSON ([Developer Setup](../USER_GUIDE.md#developer-setup)). Filter
  by the reviewer's model name.
- **Review latency and outcomes:** each pre-push review writes
  `.prism/results/*-pre-push-review.json` ([Results](../USER_GUIDE.md#results)). Its `status` is
  `ok`, `findings`, `error` or `skipped`, and `finished_at` minus `started_at` is the duration:

```bash
for f in .prism/results/*-pre-push-review.json; do
  jq -r 'def t: sub("\\.[0-9]+Z$"; "Z") | fromdate;
         [.status, ((.finished_at|t) - (.started_at|t))] | @tsv' "$f"
done | sort -k2 -n
```

  Count the rows per status for outcomes; the middle row of the sorted durations is the median.

## 6. What to measure

Do not take this document's word for the benefit. Measure before and after enabling codewatch
(a few weeks each), on the same repos. PRISM already collects most of what you need; the
metric names and their caveats are in the [Data Architecture metrics catalog](DATA-ARCHITECTURE.md#cloudwatch-metrics-catalog),
and the [Leader Guide scorecard](LEADER_GUIDE.md#2-enhanced-dora-scorecard) shows how to present
them.

| Question | Metric in PRISM | Source |
|---|---|---|
| Do PRs need fewer review rounds? | `pr.reviews_changes_requested` against `pr.reviews_approved` per PR | `prism.d1.pr` ([event schema](DATA-ARCHITECTURE.md#event-schema)) |
| Do PRs arrive cleaner? | Eval-gate findings and high findings per PR, pass/fail result and score | `prism.d1.eval` (`eval.findings`, `eval.high_findings`, `eval.result`) |
| Do secrets still reach the remote? | Secrets caught by the CI gitleaks scan per PR; local pre-commit blocks in `.prism/results/` | `prism.d1.security.code_review` with the gitleaks source; codewatch results (local only) |
| Do changes merge faster? | `LeadTimeForChanges` (PR opened to merged, p50) | [DORA metrics](DATA-ARCHITECTURE.md#dora-metrics) |
| Does quality hold? | `ChangeFailureRate`, and `RevertedAICommits` / `MergedAICommits` | [DORA](DATA-ARCHITECTURE.md#dora-metrics) and [attribution metrics](DATA-ARCHITECTURE.md#attribution-metrics-codeburn-spans--no-git-hooks-required) |
| Is local review being skipped? | Commits recorded as `skipped` (no matching pre-commit scan) and pushes with "no reviewer" | Codewatch results, shown in the [local dashboard](../USER_GUIDE.md#local-dashboard) |

Known gaps: codewatch results stay on the developer's machine and are not sent to PRISM's
pipeline, so team-wide local numbers need the CI-side metrics above. PRISM does not record time
to first review; lead time is the nearest proxy. Review verdict counts depend on reviewers using
"request changes" consistently.

## References

Accessed 2026-11-13. Vendor reports are marked.

**Cost of defects and delivery**

1. Boehm, B. and Basili, V. R. "Software Defect Reduction Top 10 List." *IEEE Computer* 34(1), 2001. [PDF](https://www.cs.umd.edu/users/basili/publications/journals/J81.pdf)
2. Menzies, T., Nichols, W., Shull, F. and Layman, L. "Are delayed issues harder to resolve? Revisiting cost-to-fix of defects throughout the lifecycle." *Empirical Software Engineering* 22(4), 2017. [arXiv:1609.04886](https://arxiv.org/abs/1609.04886)
3. Bossavit, L. *The Leprechauns of Software Engineering.* Leanpub, 2012-2015. [Book](https://leanpub.com/leprechauns); [notes on the IBM figures](https://gist.github.com/Morendil/ebfa32d10528af04e2ccb8995e3cb4a7); [The Register coverage, 2021](https://www.theregister.com/software/2021/07/22/everyone-cites-that-bugs-are-100x-more-expensive-to-fix-in-production-research-but-the-study-might-not-even-exist/1371906)
4. DORA. *Accelerate State of DevOps Report 2024.* Google Cloud, 2024. [PDF](https://dora.dev/research/2024/dora-report/2024-dora-accelerate-state-of-devops-report.pdf)
5. DORA. "Capabilities: Working in small batches." [dora.dev](https://dora.dev/capabilities/working-in-small-batches/)

**Code review**

6. Bacchelli, A. and Bird, C. "Expectations, Outcomes, and Challenges of Modern Code Review." ICSE 2013. [Microsoft Research](https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/)
7. Mäntylä, M. V. and Lassenius, C. "What Types of Defects Are Really Discovered in Code Reviews?" *IEEE TSE* 35(3), 2009. [Publication list](https://lassenius.wordpress.com/publications/); [summary in Mäntylä's later paper](https://mmantyla.github.io/Mantyla+Empirical+CameraReady.pdf)
8. Czerwonka, J., Greiler, M. and Tilford, J. "Code Reviews Do Not Find Bugs: How the Current Code Review Best Practice Slows Us Down." ICSE SEIP 2015. [Microsoft Research](https://www.microsoft.com/en-us/research/publication/code-reviews-do-not-find-bugs-how-the-current-code-review-best-practice-slows-us-down/)
9. Sadowski, C., Söderberg, E., Church, L., Sipko, M. and Bacchelli, A. "Modern Code Review: A Case Study at Google." ICSE SEIP 2018. [Google Research](https://research.google/pubs/modern-code-review-a-case-study-at-google/); [PDF](https://sback.it/publications/icse2018seip.pdf)
10. SmartBear. "Best Practices for Code Review" (Cisco case study from *Best Kept Secrets of Peer Code Review*, 2006). Vendor. [smartbear.com](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/)
11. Sadowski, C., van Gogh, J., Jaspan, C., Söderberg, E. and Winter, C. "Tricorder: Building a Program Analysis Ecosystem." ICSE 2015. [PDF](https://petertsehsun.github.io/soen7481/papers/tricoder.pdf)
12. Sadowski, C. et al. "Lessons from Building Static Analysis Tools at Google." *Communications of the ACM* 61(4), 2018. [CACM](https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/)

**AI-generated code**

13. Pearce, H. et al. "Asleep at the Keyboard? Assessing the Security of GitHub Copilot's Code Contributions." IEEE S&P 2022. [arXiv:2108.09293](https://arxiv.org/abs/2108.09293)
14. Perry, N., Srivastava, M., Kumar, D. and Boneh, D. "Do Users Write More Insecure Code with AI Assistants?" ACM CCS 2023. [arXiv:2211.03622](https://arxiv.org/abs/2211.03622)
15. Veracode. *2025 GenAI Code Security Report.* Vendor. [Report](https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report); [blog](https://www.veracode.com/blog/genai-code-security-report)
16. Vero, M. et al. "BaxBench: Can LLMs Generate Correct and Secure Backends?" ICML 2025. [arXiv:2502.11844](https://arxiv.org/abs/2502.11844)
17. Semgrep. "Is AI-Generated Code Secure? Testing Claude Opus 5.5." September 2026. Vendor. [Blog](https://semgrep.dev/blog/2026/claude-opus-5-5-susvibes-benchmark)
18. Help Net Security. Coverage of DryRun Security's *Agentic Coding Security Report*, March 2026. Vendor study, secondary source. [Article](https://www.helpnetsecurity.com/2026/03/13/claude-code-openai-codex-google-gemini-ai-coding-agent-security/)
19. GitClear. *AI Copilot Code Quality: 2025 Look Back at 12 Months of Data.* Vendor. [Report](https://www.gitclear.com/ai_assistant_code_quality_2025_research)
20. Makarychev, K. "Shift-Left Security Scanning With Claude Code & Semgrep." Provectus, March 2026. [Blog](https://provectus.com/blog/shift-left-security-scanning-with-claude-code-semgrep/)
21. Semgrep. "Finding vulnerabilities in modern web apps using Claude Code and OpenAI Codex." 2025. Vendor. [Blog](https://semgrep.dev/blog/2025/finding-vulnerabilities-in-modern-web-apps-using-claude-code-and-openai-codex/)

**Secrets**

22. GitGuardian. *The State of Secrets Sprawl 2026.* Vendor. [Summary](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/); [report page](https://www.gitguardian.com/state-of-secrets-sprawl)
23. Meli, M., McNiece, M. R. and Reaves, B. "How Bad Can It Git? Characterizing Secret Leakage in Public GitHub Repositories." NDSS 2019. [PDF](https://www.ndss-symposium.org/wp-content/uploads/2019/02/ndss2019_04B-3_Meli_paper.pdf)
24. Gamazo, W. and Quist, N. "EleKtra-Leak: Tracking Malicious Operations of Exposed IAM Keys." Palo Alto Networks Unit 42, 2023. [Unit 42](https://unit42.paloaltonetworks.com/malicious-operations-of-exposed-iam-keys-cryptojacking/)
25. GitHub Docs. "Removing sensitive data from a repository." [docs.github.com](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

**Separate reviewers, self-correction and judges**

26. Huang, J. et al. "Large Language Models Cannot Self-Correct Reasoning Yet." ICLR 2024. [arXiv:2310.01798](https://arxiv.org/abs/2310.01798)
27. Kamoi, R. et al. "When Can LLMs Actually Correct Their Own Mistakes? A Critical Survey of Self-Correction of LLMs." TACL 2024. [arXiv:2406.01297](https://arxiv.org/abs/2406.01297)
28. Stechly, K., Valmeekam, K. and Kambhampati, S. "On the Self-Verification Limitations of Large Language Models on Reasoning and Planning Tasks." 2024. [arXiv:2402.08115](https://arxiv.org/abs/2402.08115)
29. Madaan, A. et al. "Self-Refine: Iterative Refinement with Self-Feedback." NeurIPS 2023. [arXiv:2303.17651](https://arxiv.org/abs/2303.17651)
30. Shinn, N. et al. "Reflexion: Language Agents with Verbal Reinforcement Learning." NeurIPS 2023. [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)
31. Zheng, L. et al. "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena." NeurIPS 2023. [arXiv:2306.05685](https://arxiv.org/abs/2306.05685)
32. Panickssery, A., Bowman, S. R. and Feng, S. "LLM Evaluators Recognize and Favor Their Own Generations." NeurIPS 2024. [arXiv:2404.13076](https://arxiv.org/abs/2404.13076)
33. McAleese, N. et al. "LLM Critics Help Catch LLM Bugs." OpenAI, 2024. [arXiv:2407.00215](https://arxiv.org/abs/2407.00215); [blog](https://openai.com/index/finding-gpt4s-mistakes-with-gpt-4/)
34. Du, Y. et al. "Improving Factuality and Reasoning in Language Models through Multiagent Debate." 2023. [arXiv:2305.14325](https://arxiv.org/abs/2305.14325)
35. Cobbe, K. et al. "Training Verifiers to Solve Math Word Problems." 2021. [arXiv:2110.14168](https://arxiv.org/abs/2110.14168)
36. Greshake, K. et al. "Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection." 2023. [arXiv:2302.12173](https://arxiv.org/abs/2302.12173)
37. OWASP GenAI Security Project. "LLM01: Prompt Injection." [genai.owasp.org](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
38. Anthropic. "Building effective agents." December 2024. [anthropic.com](https://www.anthropic.com/engineering/building-effective-agents)

**Agent hooks and vendor integrations**

39. Anthropic. "Hooks reference" (Claude Code). [code.claude.com](https://code.claude.com/docs/en/hooks)
40. Cursor. "Hooks." [cursor.com](https://cursor.com/docs/hooks)
41. OpenAI. "Hooks" (Codex). [learn.chatgpt.com](https://learn.chatgpt.com/docs/hooks)
42. Snyk. "Secure at Inception" Claude Code plugin. [GitHub](https://github.com/snyk/claude-plugin-snyk)
43. Semgrep. Guardian. [Product page](https://semgrep.dev/guardian/); [GitHub](https://github.com/semgrep/guardian); [docs](https://www.semgrep.dev/docs/guardian)
44. Sonar. "Now available: SonarQube plugin for Claude Code." 2026. [Blog](https://www.sonarsource.com/blog/now-available-sonarqube-plugin-for-claude-code/); [setup](https://www.sonarsource.com/developers/blueprints/set-up-the-sonarqube-plugin-for-claude-code/)
45. CodeRabbit. CLI and agent mode. [Product page](https://www.coderabbit.ai/cli); [agent mode docs](https://docs.coderabbit.ai/cli/agent-mode)

**Pricing**

46. Anthropic. "Pricing" (Claude API), read 2026-11-13. [platform.claude.com](https://platform.claude.com/docs/en/about-claude/pricing)
47. Amazon Web Services. "Amazon Bedrock pricing." [aws.amazon.com](https://aws.amazon.com/bedrock/pricing/)
