export const MAX_INSPECTION_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_INSPECTION_OUTPUT_BYTES = 4 * 1024 * 1024;
// Covers two revision inputs, the 200 MiB archive envelope, V8's managed
// heap budget, and native parser/IPC overhead. The RSS watchdog includes all
// allocations in the parser process, including Buffer and ArrayBuffer data.
export const MAX_INSPECTION_RSS_MB = 640;
