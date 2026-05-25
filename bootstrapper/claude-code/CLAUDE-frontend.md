# CLAUDE.md — Frontend Teams

> PRISM D1 Velocity — AI-native SDLC bootstrapper.
> Drop this file at the root of your repo as `CLAUDE.md`.

## Development Philosophy

This repository follows **spec-first development**. Every component or feature begins with a specification authored in Kiro (or manually using the templates in `spec-templates/`). UI code is generated or written to fulfill the spec and is evaluated against its acceptance criteria.

## Workflow Rules

### 1. Spec-First — No Components Without a Spec

- Before building any new component or feature, ensure a corresponding spec exists in `specs/` (or `.kiro/specs/`).
- Use the `spec-templates/` templates for consistency.
- Reference the spec in your commit with the `Spec-Ref:` trailer.

### 2. AI Origin Tagging

Every commit MUST include an `AI-Origin` trailer:

```
AI-Origin: ai-generated    # Entirely produced by AI
AI-Origin: ai-assisted     # Human-authored with AI help
AI-Origin: human           # No AI involvement
```

If the AI model is known, also include:

```
AI-Model: anthropic.claude-sonnet-4-20250514
```

### 3. Component Spec Template

Every new component should have a spec covering:

- **Purpose**: What the component does and where it appears.
- **Props / API**: All accepted props with types, defaults, and descriptions.
- **States**: All visual states (default, loading, error, empty, disabled).
- **Interactions**: User interactions and their outcomes.
- **Responsive behavior**: How the component adapts across breakpoints.
- **Accessibility**: ARIA roles, keyboard navigation, screen reader behavior.

### 4. Accessibility Requirements

All UI code MUST meet WCAG 2.1 AA compliance:

- Every interactive element MUST be keyboard-navigable.
- Every image MUST have meaningful `alt` text (or `alt=""` for decorative images).
- Color contrast ratios MUST meet AA minimums (4.5:1 for normal text, 3:1 for large text).
- Form inputs MUST have associated `<label>` elements.
- Dynamic content updates MUST use ARIA live regions.
- Focus management MUST be handled for modals, drawers, and route changes.
- Test with at least one screen reader (VoiceOver or NVDA) before marking a feature complete.

### 5. Design System References

- Use the project's design system tokens for all spacing, color, and typography values.
- Never hard-code hex colors, pixel spacing, or font sizes — use tokens / CSS variables.
- Component naming follows the design system's conventions.
- If a component does not exist in the design system, propose an addition via spec before building a one-off.

### 6. Visual Regression Testing

- Every new component MUST have Storybook stories (or equivalent) covering all visual states.
- Visual regression snapshots are captured in CI via the `prism-eval-gate` workflow.
- If a snapshot diff is detected, review it intentionally — do not blindly update snapshots.
- Aim for snapshot coverage of: default, loading, error, empty, hover, focus, and disabled states.

### 7. Testing Standards

- Unit tests for all utility functions and hooks.
- Component tests (Testing Library) for user interactions and conditional rendering.
- No tests that assert on implementation details (e.g., internal state, CSS class names).
- Target: >= 80% line coverage on new code.

### 8. Bedrock Evaluation

AI-generated UI code is evaluated against:

- **Code Quality**: `.prism/.prism/eval-harness/rubrics/code-quality.json`
- **Security Compliance**: `.prism/.prism/eval-harness/rubrics/security-compliance.json`

Code scoring below the configured threshold (default 0.82) MUST be revised before merging.

## Code Patterns

### Preferred Patterns

- Small, composable components with a single responsibility.
- Co-located files: `Button/Button.tsx`, `Button/Button.test.tsx`, `Button/Button.stories.tsx`.
- Controlled components with clear prop interfaces.
- Error boundaries wrapping major page sections.
- Lazy loading for routes and heavy components.

### Patterns to Avoid

- Inline styles (use design tokens / CSS modules / styled-components).
- Direct DOM manipulation — use framework primitives.
- `any` types in TypeScript — use explicit types or generics.
- Fetching data inside presentational components — separate data and display concerns.
- Suppressing linter warnings without a documented justification.

## Metrics — PRISM Event Emission

This repo emits events to the `prism-d1-metrics` EventBridge bus:

| Event | When |
|---|---|
| `prism.d1.commit` | Every commit (via git hook) |
| `prism.d1.pr` | PR merge (via GitHub Actions) |
| `prism.d1.eval` | Bedrock Evaluation run |
| `prism.d1.deploy` | Deployment to any environment |

Ensure the metric hooks are installed (`bash prism-cli bootstrapper install-git-hooks`) and GitHub workflows are configured.

## Quick Reference

| Item | Location |
|---|---|
| Spec templates | `spec-templates/` |
| Eval rubrics | `.prism/.prism/eval-harness/rubrics/` |
| Git hooks | `metric-hooks/` |
| CI workflows | `.github/workflows/prism-*.yml` |
| PRISM config | `.prism/config.json` |
