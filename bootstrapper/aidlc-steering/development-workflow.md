# PRISM AI-DLC Development Workflow

> Adapted from [AWS AI-DLC Methodology](https://github.com/awslabs/aidlc-workflows).
> This steering file guides AI coding agents through a structured development lifecycle
> while emitting PRISM metrics at every stage.

## Adaptive Workflow Principle

**The workflow adapts to the work, not the other way around.**

The AI agent assesses what stages are needed based on:
1. User's stated intent and clarity
2. Existing codebase state
3. Complexity and scope of change
4. Risk and impact assessment

---

## Phase 1: Inception (Plan Before You Build)

### 1.1 Workspace Detection (ALWAYS)

Before making any changes:
- Detect if this is a greenfield or brownfield project
- Scan for existing specs in `specs/` directory
- Check for `.prism/config.json` with team configuration
- Check for existing `aidlc-state.md` (resume previous session if found)
- Log initial request in session state

### 1.2 Requirements Analysis (ALWAYS — Adaptive Depth)

Depth adapts to complexity:

| Request Type | Depth | What Happens |
|---|---|---|
| Simple bug fix | Minimal | Document intent, skip to code |
| Feature addition | Standard | Gather functional + non-functional requirements |
| Architecture change | Comprehensive | Full requirements with traceability |

**Steps:**
1. Analyze user request (clarity, type, scope, complexity)
2. Determine requirements depth
3. Ask clarifying questions if needed (use structured format)
4. Generate or reference a spec in `specs/`

### 1.3 Spec Creation (CONDITIONAL)

**Execute if:** New feature, API change, or architecture modification.
**Skip if:** Bug fix, dependency update, config change.

- Write spec in `specs/<feature-name>.md` using PRISM spec template
- Include: requirements, acceptance criteria, interface contracts, edge cases
- Add `Spec-Ref: specs/<feature-name>.md` trailer to commits

### 1.4 Workflow Planning (ALWAYS)

Before coding:
1. Determine which phases to execute
2. Identify files to modify/create
3. Plan test strategy
4. Estimate complexity and risk
5. Present plan for user approval

---

## Phase 2: Construction (Build It Right)

### 2.1 Design (CONDITIONAL)

**Execute if:** New data models, complex business logic, infrastructure changes.

- Document component design decisions
- Define interfaces and contracts
- Consider NFR requirements (performance, security, scalability)

### 2.2 Code Generation (ALWAYS)

**Two-part execution:**

**Part 1 — Plan:** Create a detailed implementation plan with explicit steps.
**Part 2 — Execute:** Generate code following the approved plan.

**PRISM requirements for every code generation:**
- Tag AI origin: `AI-Origin: claude-code` (or `kiro`, `q-developer`)
- Tag model: `AI-Model: <model-id>`
- Reference spec: `Spec-Ref: specs/<name>.md` (if applicable)
- Write or update tests alongside code
- Follow existing code conventions and patterns

### 2.3 Build and Test (ALWAYS)

- Run existing test suite
- Validate new tests pass
- Check for regressions
- Report test coverage impact

---

## Phase 3: Security Agent Review (When Configured)

![Security Agent Feedback Loop](../../assets/images/security-agent-feedback-loop.svg)

AWS Security Agent performs automated security analysis at three points:

| AI-DLC Phase | Security Agent Action | Artifact Reviewed |
|---|---|---|
| After Design (Phase 1.3) | **Design Review** | Spec / design document |
| After Code (Phase 2.2) | **Code Review** | PR / source code |
| After Deploy (Staging) | **Pen Testing** | Deployed application |

**The feedback loop:** Security Agent findings feed BACK into the AI-DLC workflow:
- Design review findings → revise spec before coding
- Code review findings → fix code before merge
- Pen test findings → adjust requirements and re-implement

This feedback loop is tracked by the `FindingSurvivalRate` metric — the percentage of design-phase findings that survive to later phases. Lower = teams catching issues earlier.

**When a finding arrives:**
1. Check severity — CRITICAL/HIGH findings block the eval gate automatically (SECURITY-09)
2. Review remediation guidance from Security Agent
3. Apply fix in the current AI-DLC phase
4. Re-run the relevant Security Agent check to verify resolution

---

## Phase 4: Quality Gate (PRISM Eval)

Before requesting merge:
1. Eval gates run automatically via CI/CD (`prism-eval-gate.yml`)
2. Bedrock evaluates against appropriate rubric (code-quality, security, API, agent, spec-compliance)
3. PR comment posted with scores
4. Merge blocked if eval gate fails (score < 0.82)

---

## Session Continuity

When resuming work on a project:

1. Read `.prism/session-state.json` if it exists
2. Load context from previous session:
   - Last completed stage
   - Active spec references
   - Open questions or decisions
3. Present session summary to user
4. Continue from where work left off

### Session State Format

```json
{
  "session_id": "sess_<timestamp>",
  "project": "<repo-name>",
  "team_id": "<team-id>",
  "started_at": "ISO8601",
  "last_updated": "ISO8601",
  "current_phase": "inception|construction|quality",
  "current_stage": "<stage-name>",
  "spec_refs": ["specs/feature-a.md"],
  "decisions": [
    {"question": "...", "answer": "...", "timestamp": "ISO8601"}
  ],
  "files_modified": ["src/handler.ts"],
  "commits": ["abc1234"]
}
```

**On every significant action**, update `.prism/session-state.json` with current progress.

---

## Security Baseline (Always Enforced)

The following security rules apply to ALL code generation:

1. **Encryption** — Every data store must have encryption at rest (KMS) and in transit (TLS 1.2+)
2. **Access logging** — Load balancers, API gateways, and CDNs must have access logging enabled
3. **Application logging** — Structured logging with correlation IDs; never log secrets, tokens, or PII
4. **HTTP headers** — Set CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
5. **Input validation** — Validate type, length, format on all API parameters; use parameterized queries
6. **Least privilege** — Specific resource ARNs and actions in IAM policies; no wildcards without documented exception
7. **Error handling** — Generic errors to clients; stack traces and internals logged server-side only
8. **Dependency security** — No known vulnerable dependencies; pin versions; review transitive deps

---

## Commit Convention

Every commit must include trailers:

```
feat: implement user search endpoint

Spec-Ref: specs/user-search.md
AI-Origin: claude-code
AI-Model: claude-sonnet-4
```

These trailers are parsed by PRISM git hooks to emit metrics automatically.

---

## Metric Emission Points

The AI-DLC workflow generates PRISM metrics at these points:

| Action | Event Type | Metric |
|---|---|---|
| Commit with AI trailer | `prism.d1.commit` | AI-to-merge ratio, lines changed |
| PR merged | `prism.d1.pr` | Lead time, acceptance rate, spec-to-code hours |
| Eval gate runs | `prism.d1.eval` | Eval score, pass/fail, rubric name |
| Agent invocation | `prism.d1.agent` | Steps, tools, tokens, duration |
| Guardrail triggered | `prism.d1.guardrail` | Category, action, agent name |

All metrics flow to CloudWatch dashboards automatically via the PRISM pipeline.
