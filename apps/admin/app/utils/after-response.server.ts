import { createContext, type RouterContextProvider } from 'react-router'

/**
 * Work that may finish after the response is sent. On Workers the entry
 * stores the request's `ExecutionContext` here, so `waitUntil` keeps the
 * work alive (about 30 seconds past the response); on Node the process
 * simply keeps running. Anything that must finish needs its own safety net
 * (for platform campaigns, the Admin Worker's cron runs
 * `resumeStalePlatformCampaigns`).
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

/** Time background work may take on Workers, inside the ~30 s `waitUntil`. */
const AFTER_RESPONSE_BUDGET_MS = 20_000

/**
 * How long background work started by this request should run before it
 * stops on its own: a budget on Workers, where `waitUntil` ends it, and
 * `undefined` on Node, where nothing cuts it off.
 */
export function afterResponseBudgetMs(
	context: Readonly<RouterContextProvider> | undefined,
): number | undefined {
	try {
		return context?.get(executionContext) ? AFTER_RESPONSE_BUDGET_MS : undefined
	} catch {
		return undefined
	}
}
