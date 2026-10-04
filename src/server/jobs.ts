// Runs booked on the platform queue. The queue delivers due jobs once a minute,
// and the booking key here is the target minute, which the queue keeps for good
// whatever became of its job: a repeat gets the job it already has.

/**
 * The earliest a run can be booked for: the next minute, never the current one.
 * A run books its follow-up while its own job is still being delivered, and
 * that job's minute is this minute or earlier; booking the same minute would
 * hand the run its own job back and the chain would stop. The queue would only
 * deliver at the next minute anyway, so nothing is slower.
 */
export function bookableAt(runAt: Date, now = new Date()): Date {
  const next = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  return runAt.getTime() < next ? new Date(next) : runAt;
}
