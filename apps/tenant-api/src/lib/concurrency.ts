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
