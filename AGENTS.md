# Package Boundaries

# Semble Code Search

- Use the Semble `search` MCP tool first when locating an implementation or
  discovering relevant files. Pass the repository root as `repo`.
- Search once with a focused description of the behavior or symbol, then read
  the returned file at the reported line. Do not repeat the same discovery with
  Grep or Glob.
- Use `content: docs`, `content: config`, or `content: all` when the answer is
  not limited to source code.
- Use Semble `find_related` with a returned file and line to discover similar
  implementations.
- Use Grep when every literal occurrence is required, such as all callers
  affected by a rename.

Evaluate a proposed package boundary in this order:

- **Change closure:** Related changes stay inside the package in most cases.
- **Stable dependency direction:** Dependencies point from orchestration and policy toward stable, lower-level capabilities.
- **Deep domain knowledge:** It contains a cohesive body of rules or behavior, not just grouped utilities.
- **Independent verification:** Its behavior and boundaries can be tested without assembling the whole system.
- **Small interface:** It exposes a narrow entry point and keeps implementation details private.
- **Worth the separation cost:** The gains in ownership, cohesion, and verification outweigh extra APIs, wiring, builds, and navigation.
- **One-sentence purpose:** Its responsibility can be stated clearly in one sentence.
