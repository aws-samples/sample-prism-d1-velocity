# Spec: [Data Model Name]

> Template: `data-model` | PRISM D1 Velocity

## Summary

_One-paragraph description of what this data model represents and its role in the system._

## Entity Definition

- **Name**: `EntityName`
- **Storage**: `DynamoDB | RDS PostgreSQL | Aurora | S3`
- **Access Pattern**: `read-heavy | write-heavy | balanced`
- **Estimated Scale**: `N records at steady state`

## Requirements

1. The model MUST store [describe the core data this entity represents].
2. The model MUST support querying by [list primary access patterns].
3. The model MUST enforce uniqueness on [list unique fields/combinations].
4. The model MUST track `created_at` and `updated_at` timestamps on all records.
5. The model MUST support soft-delete via a `deleted_at` timestamp (if applicable).
6. All fields containing PII MUST be identified and documented for compliance.
7. _[Add additional requirements]_

## Schema

| Field | Type | Required | Default | Constraints | Notes |
|---|---|---|---|---|---|
| `id` | `string (UUID)` | yes | auto-generated | primary key | |
| `name` | `string` | yes | — | max 255 chars | |
| `status` | `enum` | yes | `active` | `active`, `inactive`, `archived` | |
| `created_at` | `datetime` | yes | auto-generated | ISO8601 UTC | immutable |
| `updated_at` | `datetime` | yes | auto-generated | ISO8601 UTC | |
| `deleted_at` | `datetime` | no | null | ISO8601 UTC | soft-delete marker |
| _[add fields]_ | | | | | |

## Indexes / Access Patterns

| Access Pattern | Index Type | Key | Sort Key | Projection |
|---|---|---|---|---|
| Get by ID | Primary | `id` | — | All |
| List by status | GSI | `status` | `created_at` | All |
| _[add patterns]_ | | | | |

## Relationships

- **Has many**: _[List child entities and the foreign key]_
- **Belongs to**: _[List parent entities and the foreign key]_
- **References**: _[List any lookup/reference relationships]_

## Acceptance Criteria

### Create

**Given** valid input data with all required fields,
**When** a new record is created,
**Then** it is persisted with an auto-generated `id`, `created_at`, and `updated_at`.

### Read by ID

**Given** an existing record ID,
**When** the record is fetched,
**Then** all fields are returned accurately.

### Update

**Given** an existing record and valid update payload,
**When** the record is updated,
**Then** only the specified fields change and `updated_at` is refreshed.

### Soft Delete

**Given** an existing active record,
**When** a delete operation is performed,
**Then** the record's `deleted_at` is set to the current timestamp and it is excluded from default queries.

### Query by Access Pattern

**Given** records matching a specific access pattern,
**When** the query is executed,
**Then** results are returned in the expected order with pagination support.

### _[Add scenario-specific criteria]_

**Given** _[precondition]_,
**When** _[action]_,
**Then** _[expected result]_.

## Design Constraints

- Migrations MUST be backward-compatible (no dropping columns in the same release that removes code).
- DynamoDB tables MUST use on-demand capacity unless traffic patterns are well-understood.
- RDS schema changes MUST be applied via a migration tool (e.g., Flyway, Alembic, Prisma Migrate).
- _[Add project-specific constraints]_

## Dependencies

- **Storage service**: _[DynamoDB, RDS, etc.]_
- **Consumed by**: _[List APIs or services that read/write this model]_
- **Produces events for**: _[List downstream consumers, if any]_

## Metrics to Emit

| Event Type | When | Key Fields |
|---|---|---|
| `prism.d1.commit` | Schema code committed | `ai_context.origin` |
| `prism.d1.eval` | Eval gate runs on PR | `metric.name: "eval_score"` |

Application-level metrics for the data layer:

- `db.query.duration` — Histogram by operation type and table.
- `db.query.throttle_count` — Counter of throttled requests (DynamoDB).
- `db.connection_pool.utilization` — Gauge (RDS).

## Eval Criteria

Bedrock Evaluation should check:

- **Schema correctness**: Do all fields match the spec?
- **Constraint enforcement**: Are uniqueness, required fields, and enums enforced?
- **Migration safety**: Is the migration backward-compatible?
- **Index coverage**: Do indexes support all listed access patterns?
- **Test coverage**: Do tests cover CRUD and edge cases?

Rubric: `.prism/.prism/eval-harness/rubrics/code-quality.json`
