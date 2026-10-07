---
id: "0013"
title: Return FORBIDDEN for denied writes to documents the caller can read
status: proposed
created: 2026-10-07
---

# Return FORBIDDEN for denied writes to documents the caller can read

Public CRUD currently conceals every denied `get`, `update`, `delete`, and `set` as
`NOT_FOUND` without a reason (`PolicyEvaluator.evaluateCollection` with `conceal: true`).
Concealment protects existence, but it also applies when the caller may `get` the same
document and therefore already knows it exists. Then `NOT_FOUND` reveals nothing, yet it
hides the real outcome and drops the policy reason. The README's reason example,
`doc?.isSeeded ? read : grant(...)`, is exactly this case: `SEEDED_DATA_IMMUTABLE` reaches
clients through action gates but never through CRUD `update` or `delete`. An application
integration test expected `403` for a member's denied update and received `404`.

Proposal: when `update`, `delete`, or overwrite `set` is denied on an existing document,
re-evaluate the collection `accessPolicy` for that document as
`{ operation: "get", permission: "get", doc }`. If `get` is allowed, throw `FORBIDDEN`
with the denial reason of the original permission; otherwise keep `NOT_FOUND`. Missing
documents, denied `get`, and `set` to a missing id remain `NOT_FOUND`, so a caller without
read access still cannot distinguish absence from denial. `add`, `list`, and action gates
are unchanged.

```ts
const result = await client.items.update("seeded-1", { name: "x" });
// before: { kind: "operation", code: "NOT_FOUND", status: 404 }
// after (caller may get the document):
// { kind: "operation", code: "FORBIDDEN", status: 403, reason: { code: "SEEDED_DATA_IMMUTABLE" } }
```

The extra evaluation must not reuse the grant computed for the write. Policies may branch on
`operation`, `permission`, or `nextDoc`, so that grant does not decide `get`. The re-evaluation
runs only on the denial path and sees the stored document, never `nextDoc`. A throwing or
invalid policy fails the same way as any other evaluation.

## Prior art

- Django REST framework `DjangoObjectPermissions` checks read permission after a denied
  write and raises `Http404` without it, otherwise `403`
  ([source](https://github.com/encode/django-rest-framework/blob/main/rest_framework/permissions.py)).
  Generic views return `404` outside `get_queryset()` and `403` from object permission checks.
- GitLab REST API returns `404` when the user is not authorized to access a resource and `403`
  when an accessible resource's action is not allowed, such as deleting a project
  ([status codes](https://docs.gitlab.com/api/rest/troubleshooting/)).
- Amazon S3 discloses a missing key (`404`) only to callers with `s3:ListBucket`; others get
  `403` ([GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)).
  Disclosure follows a separate visibility permission, as proposed here.
- Firestore evaluates rules with `resource == null` for missing documents and returns permission
  denied for any denial ([rules conditions](https://firebase.google.com/docs/firestore/security/rules-conditions)).
- RFC 9110 §15.5.4 lets a server that wishes to hide a forbidden resource's existence respond
  with `404` instead of `403`.

## Alternatives

Keeping uniform concealment requires no change and is the strictest disclosure rule, but
readable documents keep losing denial reasons and remain surprising in tests and UI.

Returning `FORBIDDEN` for every denied write on an existing document while missing documents
stay `NOT_FOUND` turns writes into an existence oracle for callers without read access. This
matters because `add(data, { id })` allows caller-chosen, guessable ids.

A uniform Firestore-style `FORBIDDEN` would evaluate policies without a document for missing
ids and return `FORBIDDEN` whenever they deny. It hides existence without a second
evaluation, but changes `get` and missing-document behavior. Owner-scoped policies such as
`doc?.ownerId === user.id` would answer a mistyped id with `FORBIDDEN` instead of
`NOT_FOUND`.

Deriving visibility from `list` (as S3 does) would need the `where` scope to prove that a
specific document is listable. Single-document `get` is the direct capability.

## Compatibility and verification

This changes the public error contract. Clients that branch on `NOT_FOUND` after denied writes
to readable documents must also handle `FORBIDDEN`. Update the README policy section and the
reason section, which currently states that concealed denials never carry reasons.

Tests must cover, for `update`, `delete`, and overwrite `set`: denied write with `get` allowed
(`FORBIDDEN` with reason), denied write with `get` denied (`NOT_FOUND` without reason),
missing documents and `set` to a missing id (`NOT_FOUND`), policies that branch on
`operation` or `nextDoc`, the validation-failure path that evaluates policy before rethrowing,
the policy-bound `collection` facades inside action handlers, and unchanged `add`, `list`, `get`, and
action-gate behavior.
