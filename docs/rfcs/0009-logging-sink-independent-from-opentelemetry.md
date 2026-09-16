---
id: "0009"
title: Keep log events independent of OpenTelemetry
status: accepted
implementation: complete
created: 2026-09-16
---

# Keep log events independent of OpenTelemetry

Core creates backend-independent `LogEvent` values, filters levels, and invokes one replaceable logger; logging is off by default and logger failures cannot change request outcomes. Events omit OTel-specific IDs. Do not log document bodies, action input/output, execution context, headers, cookies, credentials, or bindings; query comparison values are restricted to debug events.

Applications choose and compose sinks. An optional OpenTelemetry adapter maps events to LogRecords using the active context; SDK/exporter/processor/flushing setup belongs to the application, and correlated logs must be emitted while the span context is active. Cross-boundary propagation belongs to tracing, allowing core tracing abstractions without an OTel dependency. Revisit only after checking context management when required correlation still fails.
