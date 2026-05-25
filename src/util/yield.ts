// Hand control back to the browser so it can paint/respond to input before
// the next chunk of work runs. Uses the new scheduler.yield() API when
// available (Chrome 129+) and falls back to setTimeout(0) elsewhere.
//
// Used inside long handlers to break a single long task into shorter ones,
// bounding INP by the longest sub-task rather than the whole handler.

interface SchedulerWithYield {
  yield: () => Promise<void>;
}

export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerWithYield }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
