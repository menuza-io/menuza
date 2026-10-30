import { AsyncLocalStorage } from 'node:async_hooks'

export type BudgetedRun = {
	/** Items whose task was started (and has settled). */
	started: number
	/** Items left untouched because the deadline passed first. */
	skipped: number
}

/**
 * Runs `task` for each item with at most `concurrency` tasks in flight, and
 * starts no new task once `deadline` (epoch ms) has passed. Tasks already in
 * flight are awaited, so callers must bound each task's own duration. A task
 * that throws counts as started; handle failures inside the task.
 */
export async function forEachWithBudget<T>(
	items: readonly T[],
	options: { concurrency: number; deadline: number; now?: () => number },
	task: (item: T) => Promise<void>,
): Promise<BudgetedRun> {
	const now = options.now ?? Date.now
	let next = 0
	let started = 0
	const worker = async () => {
		while (next < items.length && now() < options.deadline) {
			const item = items[next++] as T
			started++
			try {
				await task(item)
			} catch (error) {
				console.error('Budgeted task failed', error)
			}
		}
	}
	const workers = Math.max(1, Math.min(options.concurrency, items.length))
	await Promise.all(Array.from({ length: workers }, worker))
	return { started, skipped: items.length - started }
}

/**
 * Thrown when code that holds an organization's lock asks for the same lock
 * again. The lock is not re-entrant: waiting would deadlock forever, so the
 * nested call fails at once instead.
 */
export class OrgLockReentryError extends Error {
	constructor(orgId: string) {
		super(`Organization lock re-entered for ${orgId}`)
		this.name = 'OrgLockReentryError'
	}
}

export type OrgLock = <T>(
	orgId: string,
	operation: () => Promise<T>,
) => Promise<T>

type LockHolder = { orgId: string; done: boolean }

/**
 * A per-process lock per organization. The holder is recorded in
 * AsyncLocalStorage so a nested request for the same organization throws
 * instead of queueing behind itself. Work started inside the operation but
 * still running after it settles (a background promise) inherits the record;
 * the holder is marked done when the operation settles, so that work queues
 * normally.
 */
export function createOrgLock(): OrgLock {
	const locks = new Map<string, Promise<unknown>>()
	const holders = new AsyncLocalStorage<readonly LockHolder[]>()
	return async function runLocked<T>(
		orgId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const held = (holders.getStore() ?? []).filter((holder) => !holder.done)
		if (held.some((holder) => holder.orgId === orgId)) {
			throw new OrgLockReentryError(orgId)
		}
		const holder: LockHolder = { orgId, done: false }
		const guarded = () =>
			holders.run([...held, holder], async () => {
				try {
					return await operation()
				} finally {
					holder.done = true
				}
			})
		const previous = locks.get(orgId) ?? Promise.resolve()
		const run = previous.then(guarded, guarded)
		const tail = run.catch(() => {})
		locks.set(orgId, tail)
		void tail.then(() => {
			if (locks.get(orgId) === tail) locks.delete(orgId)
		})
		return run
	}
}

const sharedLock = createOrgLock()

/**
 * Serializes write operations for one org inside this process. Durable Object
 * orgs are single-threaded already; on the Node/OCI runtime this keeps punches
 * on one card from racing each other, and SQLite busy handling covers any
 * cross-process writer.
 */
export async function runExclusive<T>(
	orgId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return sharedLock(orgId, operation)
}
