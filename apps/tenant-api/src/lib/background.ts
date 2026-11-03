import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Lets services hand work to the platform's `waitUntil` without holding a
 * request context. The app middleware stores the request's `waitUntil` here;
 * on Node there is none and the long-lived process simply keeps the work
 * going.
 */
const background = new AsyncLocalStorage<(task: Promise<unknown>) => void>()

export function withBackground<T>(
	waitUntil: (task: Promise<unknown>) => void,
	fn: () => T,
): T {
	return background.run(waitUntil, fn)
}

/** Keeps the task alive past the response where the platform allows it. Never throws. */
export function runInBackground(task: Promise<unknown>): void {
	const safe = task.catch(() => {})
	try {
		background.getStore()?.(safe)
	} catch {
		/* no execution context */
	}
}
