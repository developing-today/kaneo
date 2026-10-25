# Kaneo fork: multi-repository projects and PR-interior sync

Status: **design + first slice (Session I, 2026-10-25).** First slice landed:
the `integration_repository` many-to-many model and its backfill migration.
Multi-repo routing, PR-interior sync, and comment edit/delete propagation are
designed below and remain future slices.

Source of truth for the fork decision and the fleet's product framing is the
PM-stack design record in `developing-today/code`
(`doc/2026-10-24T11-05-38Z_design_project-management-stack/…md`), sections
"Decided: we fork Kaneo" and "Why Kaneo fits the board layer". This document
is the fork's own design record; it lives in the fork because the fork is the
upstream-fork work the standing topology rule permits in its own repository.

## Grounding

Kaneo binds exactly one GitHub repository per project today. That binding is
enforced two ways in `apps/api/src/database/schema.ts`:

- `integrationTable` carries a `UNIQUE (project_id, type)` constraint, so a
  project can hold at most one `github` integration row.
- The repository itself lives inside that row's `config` JSON
  (`repositoryOwner`, `repositoryName`, `installationId`, `repositoryId`, and
  the verification fields `verifiedGithubAccountId` / `verifiedByUserId`).

The reference for this work is upstream `usekaneo/kaneo#791` (the
one-repository-per-project limit). Its comment thread adds two constraints we
inherit:

- Projects are identified by `{slug}-{number}`; splitting one project into one
  project per repository would restart numbering and break every existing
  reference. So a **project must keep one slug and one number sequence while
  linking several repositories**.
- Automation rules (branch matcher, PR status transitions) should stay at the
  **project level**, not per repository. The branch matcher already lowercases
  the slug and matches case-insensitively, so it needs no per-repo config.

Relevant code paths (as at `fork/main`):

- `plugins/github/services/task-service.ts#findAllIntegrationsByRepo` is the
  single repo→integration routing choke point for every webhook. It reads
  `repositoryId` + `installationId` out of `integration.config` and requires a
  verified binding.
- `plugins/github/services/link-manager.ts` keys external links by
  `(integrationId, resourceType, externalId)` where `externalId` is the
  issue/PR **number** — implicitly scoped to the one repository.
- `plugins/github/webhooks/issue-comment-created.ts` stores inbound issue
  comments as `activity` rows (`type = "comment"`), deduped by
  `(taskId, externalSource, externalUrl)`, and returns early for any username
  ending in `[bot]` (echo prevention). Only `action === "created"` is handled.
- `plugins/github/events/task-comment-created.ts` creates an outbound GitHub
  comment with `octokit.rest.issues.createComment({ owner: config.repositoryOwner,
  repo: config.repositoryName, … })` — create only, single repo.
- `plugins/github/webhooks/pull-request-opened.ts` / `pull-request-closed.ts`
  only resolve or move the linked task's status. No PR comment, review, or
  review-comment (line comment) handling exists anywhere.
- `plugins/github/utils/sync-echo.ts` / `inbound-echo.ts` implement a careful
  echo-detection scheme for title/description/state fields, and treat
  `integration.config` (the raw JSON string) as an optimistic-concurrency
  token throughout. Handlers compare `current.config !== integration.config`
  and abort when a concurrent write changed the row.

## (a) Multi-repository projects

### Design

A Kaneo **project** keeps one slug, one number sequence, one board, and one set
of project-level automation settings. A project's GitHub integration becomes a
**one-to-many relationship with repositories**. Concretely:

- `integration` (one row per project per provider) keeps its project-level
  settings — sync rules, branch pattern, status transitions,
  `commentTaskLinkOnGitHubIssue` — exactly where they are today.
- A new `integration_repository` table holds the repository bindings. Each row
  is `{ integrationId, repositoryOwner, repositoryName, repositoryId,
  installationId, verifiedGithubAccountId, verifiedByUserId, isPrimary }`.
- The repository a link (task ↔ issue/PR/branch) points at is recorded on
  `external_link` as `integration_repository_id`. This makes external links
  repo-scoped, which is what lets two repositories with colliding issue
  numbers coexist in one project.

The first binding a project connects is its **primary** binding and keeps
mirroring its owner/name/installation/verification in `integration.config`.
That mirroring is deliberate: `config` is the optimistic-concurrency token and
the public API contract, and legacy single-repo projects must keep working
with zero behaviour change. The mirror is the primary binding only; secondary
bindings exist only in `integration_repository`.

### Sync semantics

- **Direction:** inbound (webhooks) and outbound (task events) both already
  route through `findAllIntegrationsByRepo` (inbound) and
  `repositoryOwner`/`repositoryName` (outbound). Once routing and outbound
  reads switch to the binding table, each event resolves to the *specific*
  binding by `repositoryId`/`owner+name`, so a webhook from any bound repo
  lands on the right project, and an outbound write on a link targets the link's
  bound repository.
- **Ordering:** unchanged from today. Webhooks are processed per delivery;
  outbound writes carry the existing sync-stamp/echo metadata so a slow
  inbound echo cannot clobber a newer local edit.
- **Conflict behaviour:** a repository already bound to a *different* project
  stays allowed (GitHub is the source of truth; two boards may watch one repo,
  as today). Within one integration, a repository is bound once
  (`UNIQUE (integration_id, repository_owner, repository_name)` and, when
  known, `UNIQUE (integration_id, repository_id)`). Only one binding per
  integration is `isPrimary`.
- **Migration of existing single-repo projects:** the backfill creates one
  primary binding per existing `github` integration from its config, and points
  its existing `external_link` rows at that binding. A single-repo project is
  then byte-for-byte equivalent to its pre-migration state; `#791`'s numbering
  concern is untouched because the project/slug never splits.

### What remains after this run

- Switch `findAllIntegrationsByRepo` to resolve via `integration_repository`
  (matching verified `repositoryId`/`installationId`), and make outbound event
  handlers resolve `repositoryOwner`/`repositoryName` from the link's binding
  instead of `config`. This is the step that makes a *second* repository
  actually functional end to end.
- `external_link` uniqueness and `findExternalLink` must become
  repo-qualified (`integration_repository_id` included) so two bound repos with
  colliding issue numbers do not collide.
- Binding-management API + UI: list, add, remove secondary repositories, with
  re-verification per binding (today's verification flow proves
  `repositoryId` + `installationId` + admin account for a single repo).
- Gitea/GitLab share the same `integration_repository` table shape; their
  migration is out of scope for the GitHub slice but the table is provider-neutral.

## (b) PR-interior sync

### Design

Pull-request *status* already moves the linked task (push → in-progress,
opened → in-review, merged → done). The gap is **interior** PR activity:

1. **PR issue-comments** (`issue_comment` on a PR) — same shape as issue
   comments, just `resourceType = "pull_request"`.
2. **PR reviews** (`pull_request_review`) — top-level review body + state
   (approved / changes_requested / commented).
3. **Review (line) comments** (`pull_request_review_comment`) — threaded,
   anchored to a diff line.

The design records these three as a **new activity surface** keyed to the PR
link, rendered read-only in Kaneo and, for comments, mirrored back where
feasible. The existing `activity` table already fits comments (external source,
external user, external URL); reviews and line comments add rows of new
`type`s (`review`, `review_comment`) with `eventData` carrying review state and
the diff anchor.

### Sync semantics

- **Direction:** GitHub → Kaneo for all three, using the App's existing
  `Pull requests` read scope (no new permission needed to *read*). Kaneo →
  GitHub is feasible only for **PR issue-comments** (the App's Issues
  read/write scope already covers PR issue comments); **reviews and line
  comments are read-only** into Kaneo because writing them needs the App to
  post as a review, which is out of the current permission posture and out of
  the fleet's need.
- **Ordering:** same echo rules as issue comments. Each inbound activity row is
  deduped by its external URL; edited comments update the matching row by URL
  rather than inserting a second.
- **Conflict behaviour:** the **bot-authored-comment echo problem** the design
  record notes applies here directly. The current guard (`username.endsWith("[bot]")`)
  skips comments authored by bot/app identities inbound, which prevents the App
  echoing its own writes back — but it also drops legitimate bot activity
  (Dependabot, Renovate, the fleet's own app identities). The design keeps the
  skip as the safe default and adds a narrower escape: comments that carry the
  App's *own* installation as author are treated as echoes (ignored), while
  third-party bots are surfaced as activity. This needs the App to know its own
  installation actor; it is recorded here, not implemented.

### What remains after this run

- Register `pull_request_review` / `pull_request_review_comment` /
  PR `issue_comment` webhooks and handlers (the handler scaffold in
  `webhook-handler.ts` is where they attach).
- Activity rendering for review state and diff anchors; outbound PR
  issue-comment creation on `task.comment.created` when the link is a PR.
- The bot-author policy refinement above.

## (c) Comment edit/delete propagation

### Design

Today Kaneo's comment sync is **create-only in both directions**: inbound it
handles only `issue_comment.created`; outbound it only ever creates. The gap:

- **GitHub → Kaneo:** `issue_comment.edited` and `issue_comment.deleted` are
  not handled. An edited comment goes stale on the Kaneo side; a deleted one
  lingers.
- **Kaneo → GitHub:** Kaneo comment edits and deletions never leave Kaneo.

The design narrows scope to **issue comments** (not reviews), and to what is
safe: edits propagate both ways; deletions propagate GitHub → Kaneo (Kaneo
hides the activity row) and Kaneo → GitHub only when the comment was authored
by the syncing identity and still exists (the App cannot delete another user's
comment).

### Sync semantics

- **Direction:** edits bidirectional; deletions GitHub → Kaneo unconditional,
  Kaneo → GitHub gated on authorship.
- **Ordering:** the existing `sync-echo` scheme is reused — an inbound edit
  that matches a pending outbound intent is treated as the echo of that write,
  not a new edit; `inboundEcho` already distinguishes this for text fields and
  is extended to comment bodies keyed by `(link, commentExternalUrl)`.
- **Conflict behaviour:** comments are keyed by their external URL on the
  Kaneo side and by the GitHub comment id on the outbound side. A Kaneo edit
  races a GitHub edit → last write wins per the echo stamp, no merge. A Kaneo
  delete of a comment already deleted on GitHub is a no-op.

### What remains after this run

- Handle `issue_comment.edited` / `issue_comment.deleted` in
  `issue-comment-created.ts` (or a sibling), updating/hiding the matching
  `activity` row by URL.
- Outbound comment edit/delete on Kaneo comment events, gated by authorship,
  using the comment id captured when the comment was created (store the GitHub
  comment id on the activity row's `eventData`).

## Out of scope / explicitly not this run

- Deploying the fork. The live Kaneo (`~/pm-stack` on this laptop) keeps
  running the pinned upstream build; `developing-today/code`'s `pm-stack`
  pins the fork rev when deployment time comes. This is a note, not an action.
- The aggregator UI and link-registry projector (they read GitHub regardless
  of what the board grows).
- Upstream PRs back to `usekaneo/kaneo` (welcome, optional).