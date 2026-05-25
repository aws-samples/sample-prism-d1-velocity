# PRISM D1 Velocity -- Qualification Matrix

Use this matrix to determine the next step after scoring a customer. Find the row matching their blended score and org readiness, then follow the guidance.

---

## Decision Matrix

| Blended Score | Org Readiness | Level | Verdict | Next Step |
|:---:|:---:|:---:|:---:|---|
| 0-14 | Any | L1.0 | NOT_QUALIFIED | Revisit in 6 months; provide self-service materials |
| 15-25 | < 8 | L1.5-L2.0 | NOT_QUALIFIED | Org not ready; need executive sponsorship first |
| 15-25 | 8-11 | L1.5-L2.0 | NEEDS_FOUNDATIONS | Start with Module 00-02 only (foundations track) |
| 15-25 | >= 12 | L1.5-L2.0 | READY_FOR_PILOT | Foundations workshop + limited pilot (Module 00-02) |
| 26-40 | < 8 | L2.0-L2.5 | NOT_QUALIFIED | Technical readiness exists but org is blocking; run executive alignment |
| 26-40 | 8-11 | L2.0-L2.5 | NEEDS_FOUNDATIONS | Org readiness gap; executive alignment workshop first, then Module 01-04 |
| 26-40 | >= 12 | L2.0-L2.5 | READY_FOR_PILOT | Full workshop + 8-week pilot |
| 41-55 | < 12 | L3.0-L3.5 | NEEDS_FOUNDATIONS | Strong technical base, org needs to catch up; executive alignment + Module 04-06 |
| 41-55 | >= 12 | L3.0-L3.5 | READY_FOR_PILOT | Accelerated workshop, focus on identified gaps |
| 56-70 | < 12 | L3.5-L4.0 | NEEDS_FOUNDATIONS | Advanced practices with org lag; executive + governance workshops |
| 56-70 | >= 12 | L3.5-L4.0 | READY_FOR_PILOT | Advanced track, focus on L3-to-L4 transition |
| 71+ | >= 12 | L4.5-L5.0 | READY_FOR_PILOT | Peer-level engagement; co-innovation focus |

---

## Detailed Guidance by Scenario

### Scenario: Blended < 15, Any Org Readiness

**Verdict**: NOT_QUALIFIED

**Profile**: This organization has minimal or no AI adoption in engineering. They are not a fit for the PRISM D1 program at this time.

**Action**:
- Thank them for the assessment and share the self-service PRISM D1 getting-started materials
- Recommend they start with basic AI tool adoption (Amazon Q Developer, Copilot)
- Set a follow-up in 6 months to reassess
- Do not invest SA time in a workshop; the foundations are not there yet

**SA talking points**:
> "Your team is early in the AI engineering journey, which is completely normal. We have self-service materials that can help you get started with AI tools, and I'd love to reconnect in about six months to see how things have progressed."

---

### Scenario: Blended 15-25, Org Readiness < 8

**Verdict**: NOT_QUALIFIED

**Profile**: Some engineers are experimenting with AI tools, but the organization lacks executive sponsorship, budget, or dedicated ownership. Without org readiness, a workshop will not stick.

**Action**:
- Share the assessment findings focusing on the org readiness gap
- Recommend they secure executive sponsorship and budget before proceeding
- Offer to present the "AI Engineering Value Proposition" deck to their leadership
- Set a follow-up in 3 months

**SA talking points**:
> "Your engineers are starting to experiment with AI, which is great. The gap we see is on the organizational side -- without executive sponsorship and dedicated budget, the practices we'd introduce in a workshop won't be sustainable. Let me share some materials you can use to build the business case internally, and I can present to your leadership if that would help."

---

### Scenario: Blended 15-25, Org Readiness 8-11

**Verdict**: NEEDS_FOUNDATIONS

**Profile**: Early-stage AI adoption with partial org readiness. They have some executive awareness but gaps in budget or dedicated ownership.

**Action**:
- Recommend the foundations track: Module 00 (AI Engineering Foundations), Module 01 (Tool Standardization), Module 02 (Spec-Driven Development)
- Keep the engagement short (2-3 sessions, not a full workshop)
- Focus on quick wins: standardize tooling, introduce spec templates, measure baseline metrics
- Reassess after foundations track to determine if they are ready for full pilot

**SA talking points**:
> "You're at the point where a targeted investment in foundations will pay off quickly. I recommend we start with three focused sessions on tool standardization, spec-driven development, and baseline metrics. Once those are in place, we can reassess for a full pilot."

---

### Scenario: Blended 15-25, Org Readiness >= 12

**Verdict**: READY_FOR_PILOT

**Profile**: Early technical adoption but strong organizational backing. This is a good investment because the org is ready to support change.

**Action**:
- Run the foundations workshop (Module 00-02) with confidence that the org will support adoption
- Include a limited pilot (4 weeks) focused on one team
- Measure baseline DORA metrics before the pilot starts
- Plan for reassessment at pilot end to expand scope

---

### Scenario: Blended 26-40, Org Readiness < 8

**Verdict**: NOT_QUALIFIED

**Profile**: Paradoxical: the technical team has made real progress with AI, but the organization has not caught up. This often means a single champion is driving adoption without structural support. Risk: the champion leaves and everything regresses.

**Action**:
- Acknowledge the technical progress and identify the champion(s)
- Frame the org readiness gap as a sustainability risk
- Offer executive alignment workshop to build organizational support
- Do not start technical modules until org readiness reaches >= 8

**SA talking points**:
> "Your engineering team has done impressive work adopting AI tools. The risk I see is that these practices depend on a few champions rather than organizational structure. If those people move on, the progress could regress. I recommend we start with an executive alignment session to build the structural support these practices need to be durable."

---

### Scenario: Blended 26-40, Org Readiness 8-11

**Verdict**: NEEDS_FOUNDATIONS

**Profile**: Solid technical foundation with partial org readiness. Close to pilot-ready but needs the org to close the gap.

**Action**:
- Run executive alignment workshop (1 session) to address org readiness gaps
- Begin Module 01-04 in parallel for technical teams
- Focus on establishing metrics and visibility (Module 04) to build the ROI narrative that drives further org investment
- Target reassessment in 6-8 weeks

---

### Scenario: Blended 26-40, Org Readiness >= 12

**Verdict**: READY_FOR_PILOT

**Profile**: Ideal pilot candidate. Has both the technical foundation and organizational support to succeed in a structured engagement.

**Action**:
- Full PRISM D1 workshop (2-day format)
- 8-week pilot with defined success criteria
- Focus areas: spec-driven development, AI attribution, CI/CD eval gates, metrics dashboards
- Assign dedicated SA for the pilot duration
- Plan for post-pilot assessment to determine expansion

**SA talking points**:
> "You're in a great position to move fast. You have the tools, the team support, and the organizational backing. I recommend a full workshop followed by an 8-week pilot where we focus on [top 2-3 gaps from the assessment]. We'll define success metrics upfront and reassess at the end of the pilot."

---

### Scenario: Blended 41-55, Org Readiness < 12

**Verdict**: NEEDS_FOUNDATIONS (org gap)

**Profile**: Strong technical practices but organizational structure has not kept pace. Common in engineering-led organizations where the team has moved fast but leadership is not yet engaged.

**Action**:
- Executive alignment is the priority
- Use their strong technical metrics as the basis for building the ROI narrative
- Module 04 (Metrics & Visibility) and Module 06 (Governance) to build the bridge between engineering practices and organizational structure
- Once org readiness reaches >= 12, they can skip to advanced modules

---

### Scenario: Blended 41-55, Org Readiness >= 12

**Verdict**: READY_FOR_PILOT

**Profile**: Strong candidate. Has integrated AI workflows and organizational support. Ready for an accelerated engagement.

**Action**:
- Accelerated workshop (1 day, skip foundations)
- Focus on the assessment's identified gaps (use limiting dimension to prioritize)
- Module 05-07 track (Eval Gates, Governance, AI-Native Architecture)
- 6-week pilot focused on advanced practices
- Consider this customer for case study / reference

---

### Scenario: Blended 56-70, Org Readiness >= 12

**Verdict**: READY_FOR_PILOT (advanced)

**Profile**: Mature AI engineering practices. The engagement should focus on the L3-to-L4 transition -- moving from "AI-integrated" to "AI-native."

**Action**:
- Advanced workshop (Module 07-08)
- Focus on AI-native architecture, agentic workflows, and scaling practices across teams
- 4-week targeted engagement on specific L4 capabilities
- Peer-connect with other advanced customers
- Strong case study candidate

---

### Scenario: Blended 71+, Org Readiness >= 12

**Verdict**: READY_FOR_PILOT (co-innovation)

**Profile**: Industry-leading practices. Standard workshops are not appropriate -- this customer is at or ahead of the program content.

**Action**:
- Co-innovation engagement: work together on novel AI engineering practices
- Connect with AWS product teams for feedback and early access
- Case study and reference customer
- Consider for speaking opportunities and community leadership
- Module 09 (AI-Native Leadership) and custom content

---

## Quick Reference: Org Readiness Scoring

| Criterion | Points | How to Assess |
|-----------|:------:|---------------|
| Executive sponsor identified | 4 | Named C-level or VP actively championing AI in engineering |
| Budget allocated for AI tooling | 4 | Dedicated line item, not "coming from general eng budget" |
| Dedicated AI/platform team or owner | 4 | Named person or team with AI engineering as primary responsibility |
| Existing AWS commitment/relationship | 4 | Active AWS customer with committed spend or partnership |
| Team size appropriate (20-200 engineers) | 4 | Confirmed engineering headcount in range |
| **Total** | **20** | |

Thresholds:
- **>= 12**: Strong org readiness (at least 3 of 5 criteria met)
- **8-11**: Partial org readiness (2 of 5 criteria met)
- **< 8**: Insufficient org readiness (1 or fewer criteria met)
