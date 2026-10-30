import { createContext, type RouterContextProvider } from 'react-router'

/**
 * Work that may finish after the response is sent. On Workers the entry
 * stores the request's `ExecutionContext` here, so `waitUntil` keeps the
 * work alive (about 30 seconds past the response); on Node the process
 * simply keeps running. Use it for work a caller must not wait for, such as
 * a webhook that has to answer quickly. Anything that must finish needs its
 * own safety net (a cron sweep), since the work can still be cut short.
 */
export const executionContext = createContext<{
	waitUntil(promise: Promise<unknown>): void
} | null>(null)

export function runAfterResponse(
	context: Readonly<RouterContextProvider> | undefined,
	task: () => Promise<unknown>,
) {
	const promise = task().catch((error: unknown) => {
		console.error('Background work failed', error)
	})
	let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null
	try {
		ctx = context?.get(executionContext) ?? null
	} catch {
		ctx = null
	}
	ctx?.waitUntil(promise)
}
