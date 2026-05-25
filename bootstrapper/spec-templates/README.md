# Spec Templates

Kiro-compatible specification templates for the PRISM D1 Velocity workflow. Every feature starts with a spec — these templates make that easy.

## Available Templates

| Template | Use When |
|---|---|
| `api-endpoint.md` | Adding a new REST API endpoint |
| `data-model.md` | Creating or modifying a database entity |
| `integration.md` | Connecting to an external service |
| `agent-workflow.md` | Building an agentic workflow (PRISM Level 3+) |

## How to Use

### With Kiro

1. Open Kiro and create a new spec.
2. Paste the relevant template as your starting point.
3. Fill in the bracketed placeholders (`[...]`) with your specifics.
4. Use Kiro's spec-to-code workflow to generate implementation.

### Without Kiro (Manual)

1. Copy the template into your `specs/` directory:

   ```bash
   mkdir -p specs
   cp bootstrapper/spec-templates/api-endpoint.md specs/create-order-endpoint.md
   ```

2. Fill in all sections. Remove the `_[italicized placeholder]_` notes and replace with real content.

3. Reference the spec in your commits:

   ```
   git commit -m "Add create-order endpoint

   Spec-Ref: specs/create-order-endpoint.md
   AI-Origin: ai-assisted
   AI-Model: anthropic.claude-sonnet-4-20250514"
   ```

## Template Structure

Every template follows the same structure:

| Section | Purpose |
|---|---|
| **Summary** | One-paragraph overview |
| **Requirements** | Numbered, testable requirements |
| **Acceptance Criteria** | Given/When/Then scenarios |
| **Design Constraints** | Architectural boundaries and rules |
| **Dependencies** | Internal, external, and data dependencies |
| **Metrics to Emit** | PRISM events this feature should generate |
| **Eval Criteria** | What Bedrock Evaluation checks |

## Writing Good Specs

- **Requirements should be testable.** If you cannot write a test for it, rewrite the requirement.
- **Acceptance criteria should be specific.** Avoid vague language like "should handle errors gracefully" — instead specify what happens for each error type.
- **Include edge cases.** The Given/When/Then format makes it easy to enumerate scenarios. Cover: happy path, validation failures, auth failures, not found, concurrent access, and timeouts.
- **Reference metrics.** Every spec should identify what PRISM events the feature emits. This feeds the DORA dashboard.
- **Reference eval rubrics.** Point to the specific rubric files in `.prism/.prism/eval-harness/rubrics/` so the eval gate workflow knows what to check.

## Integration with PRISM Metrics

Each spec template includes a "Metrics to Emit" section. When implemented, these metrics flow through:

1. **Git hooks** (`metric-hooks/`) emit `prism.d1.commit` events on every commit.
2. **GitHub workflows** (`github-workflows/`) emit `prism.d1.pr`, `prism.d1.deploy`, and `prism.d1.eval` events.
3. **EventBridge** routes events to CloudWatch and QuickSight for dashboard visualization.

The spec is the source of truth for what metrics a feature should produce. During code review, verify that the implementation emits the metrics listed in the spec.
