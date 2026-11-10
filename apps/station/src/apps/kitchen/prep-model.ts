import { type DoneTask, type PrepTask } from '@repo/inventory'
import { formatAmount, thousandthsIn, unitLabel } from '../stock/model.ts'

/** Prep for the kitchen screen as pure functions. */

/** A task's quantity in the unit the item is counted in, as text ("8 L"). */
export function quantityText(
	task: Pick<PrepTask, 'baseUnit' | 'countUnit' | 'units'>,
	base: number,
	locale: string,
): string {
	const per = thousandthsIn(task.countUnit, task.baseUnit, task.units)
	if (per === null || per <= 0) return formatAmount(base / 1000, locale)
	const amount = Math.round((base / per) * 1000) / 1000
	return `${formatAmount(amount, locale)} ${unitLabel(task.countUnit, task.units, locale, amount)}`
}

/** What "How much did you make?" starts at: the plan's batches, or its amount in the count unit. */
export function plannedAnswer(task: PrepTask): {
	kind: 'batches' | 'amount'
	value: number
} {
	if (task.batches !== null && task.batches > 0) {
		return { kind: 'batches', value: task.batches }
	}
	const per = thousandthsIn(task.countUnit, task.baseUnit, task.units)
	return {
		kind: 'amount',
		value:
			per === null || per <= 0
				? task.plannedQuantity / 1000
				: Math.round((task.plannedQuantity / per) * 1000) / 1000,
	}
}

/** The `done` body for the amount the cook confirmed. */
export function doneBody(
	task: PrepTask,
	answer: { kind: 'batches' | 'amount'; value: number },
	clientId: string,
): DoneTask {
	return {
		expectedVersion: task.version,
		clientId,
		made:
			answer.kind === 'batches'
				? { kind: 'batches', count: answer.value }
				: { kind: 'amount', amount: answer.value, unit: task.countUnit },
	}
}

/** Tasks still to do or being done come first; done and skipped go last. */
export function sortedTasks(tasks: readonly PrepTask[]): PrepTask[] {
	const rank = { in_progress: 0, todo: 1, done: 2, skipped: 3 } as const
	return [...tasks].sort(
		(a, b) =>
			rank[a.status] - rank[b.status] ||
			a.itemName.localeCompare(b.itemName) ||
			(a.id < b.id ? -1 : 1),
	)
}

/** How much busier or quieter than usual, in whole percent (0 when about normal). */
export function notableDemandPercent(demandBp: number): number {
	const percent = Math.round((demandBp - 10_000) / 100)
	return Math.abs(percent) >= 5 ? percent : 0
}
