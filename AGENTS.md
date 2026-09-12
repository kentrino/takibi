# Package Boundaries

Evaluate a proposed package boundary in this order:

- **Change closure:** Related changes stay inside the package in most cases.
- **Stable dependency direction:** Dependencies point from orchestration and policy toward stable, lower-level capabilities.
- **Deep domain knowledge:** It contains a cohesive body of rules or behavior, not just grouped utilities.
- **Independent verification:** Its behavior and boundaries can be tested without assembling the whole system.
- **Small interface:** It exposes a narrow entry point and keeps implementation details private.
- **Worth the separation cost:** The gains in ownership, cohesion, and verification outweigh extra APIs, wiring, builds, and navigation.
- **One-sentence purpose:** Its responsibility can be stated clearly in one sentence.
