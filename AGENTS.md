# OBJY DB Engineering Goals

OBJY DB is an ultra-fast, large-scale, distributed, in-memory database for fully dynamic objects. Evaluate every design and implementation against these goals.

- Correctness and predictable latency come first. Preserve permissions, shard ownership, replication, and restore behavior. Distinguish deterministic ordering from snapshot isolation; never promise guarantees the implementation does not provide.
- Keep the hot path small. Select candidates before hydrating full objects. Avoid unnecessary cloning, serialization, decompression, and materialization of large result sets.
- Bulk-first is the core model. Single operations are bulks of one. Share mechanisms across public writes, streaming imports, replication, and restore rather than adding special-purpose paths.
- Memory efficiency is part of performance. Keep one authoritative copy of object data; reuse RIDs, columns, dictionaries, and existing indexes. Account for steady-state memory, temporary buffers, pending changes, and peak RSS.
- Background work still consumes CPU and memory. Use bounded batches and the existing scheduler. Keep writes visible while derived state is building. Do not hide regressions behind readiness or background execution.
- Keep storage, queries, indexes, routing, replication, persistence, and interfaces logically separated. Prefer existing mechanisms, narrow helpers, and removing redundant work. Avoid compatibility branches, speculative frameworks, and new configuration without a current need.
- S3 persists full objects as the source of truth. Derived indexes and orderings are rebuilt in memory. Do not add persisted derived state or a new worker architecture without agreement.
- Validate changes with correctness oracles and representative concurrent workloads. Compare read latency, sustained bulk throughput, restore readiness, total warmup, event-loop responsiveness, heap, ArrayBuffer memory, and RSS. Report measured results separately from estimates and targets.

For ordering work, the agreed initial regression budget is 5% for writes/imports and restore readiness, evaluated with repeated before/after runs. This is an acceptance target, not a forecast. Evaluate additional derived structures separately and revise or remove them if their benefits do not justify their costs.

Read CONTRIBUTING.md for development and verification commands. Keep unrelated user changes intact. Do not update README.md for routine implementation work unless requested; update API.md when public behavior changes.
