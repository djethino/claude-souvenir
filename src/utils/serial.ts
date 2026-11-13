/**
 * Make an async function run one call at a time in this process: each call starts when the
 * previous one has settled (succeeded or failed). Errors still reach each caller.
 */
export function serialized<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let queue: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {}); // the next call waits for this one, whatever its outcome
    return run;
  };
}
