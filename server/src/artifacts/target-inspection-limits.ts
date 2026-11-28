/**
 * IPC output safety cap for isolated target inspection responses.
 *
 * Per design doc §4.2 and PERF-01, target inspection does not impose a
 * dedicated input file size cap (such as the removed 32 MiB limit) or a fixed
 * RSS cap; memory and execution budgets are governed dynamically by
 * `computeTargetInspectionBudget` in `resource-governor.ts`.
 */
export const MAX_INSPECTION_OUTPUT_BYTES = 4 * 1024 * 1024;
