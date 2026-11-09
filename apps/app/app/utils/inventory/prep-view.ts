import {
	type DoneTask,
	type PrepLevelItem,
	type PrepTask,
	type PutPrepLevels,
	type UnitRef,
} from '@repo/inventory'
import { levelQuantity, levelText } from './item-form.ts'

/**
 * Prep as pure rules: how the day's tasks group on the board, what the
 * explanation under each one says, how the weekday levels are typed and sent,
 * and the body that closes a task. The region decides what is planned; this
 * module only shapes it for the screen.
 */

export type PrepColumns = {
	todo: PrepTask[]
	inProgress: PrepTask[]
	done: PrepTask[]
	skipped: PrepTask[]
}

export function prepColumns(tasks: readonly PrepTask[]): PrepColumns {
	return {
		todo: tasks.filter((task) => task.status === 'todo'),
		inProgress: tasks.filter((task) => task.status === 'in_progress'),
		done: tasks.filter((task) => task.status === 'done'),
		skipped: tasks.filter((task) => task.status === 'skipped'),
	}
}

/** How much more (positive) or less (negative) the weekday sells than a normal day, in whole percent. */
export function demandPercent(demandBp: number): number {
	return Math.round((demandBp - 10_000) / 100)
}

/** Whether the weekday factor is worth saying out loud (at least 5% either way). */
export function demandIsNotable(demandBp: number): boolean {
	return Math.abs(demandPercent(demandBp)) >= 5
}

/** Tasks still to do or being done, for the header count. */
export function openTaskCount(tasks: readonly PrepTask[]): number {
	return tasks.filter(
		(task) => task.status === 'todo' || task.status === 'in_progress',
	).length
}

// ── Weekday levels ──────────────────────────────────────────────────────────

/** Sunday first, as the region numbers the weekdays. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

export type LevelDrafts = {
	/** One text per weekday (0 Sunday ... 6 Saturday), in the item's count unit; empty means the usual level. */
	weekdays: string[]
	stationId: string | null
}

export function levelDraftsFromItem(item: PrepLevelItem): LevelDrafts {
	return {
		weekdays: item.weekdays.map((quantity) =>
			levelText(quantity, item.countUnit, item.baseUnit, item.units),
		),
		stationId: item.stationId,
	}
}

export function levelDraftsChanged(
	item: PrepLevelItem,
	drafts: LevelDrafts,
): boolean {
	const initial = levelDraftsFromItem(item)
	return (
		drafts.stationId !== initial.stationId ||
		drafts.weekdays.some((text, day) => text.trim() !== initial.weekdays[day])
	)
}

/** The weekdays whose text is not a number (nothing is sent while any is wrong). */
export function levelDraftProblems(
	item: PrepLevelItem,
	drafts: LevelDrafts,
): number[] {
	return drafts.weekdays.flatMap((text, day) => {
		const clean = text.trim()
		if (clean === '') return []
		return levelQuantity(clean, item.countUnit, item.baseUnit, item.units) ===
			null
			? [day]
			: []
	})
}

/** The `PUT /prep/levels` body, or null while a weekday is not a number. */
export function buildPutLevels(
	item: PrepLevelItem,
	drafts: LevelDrafts,
	locationId: string,
): PutPrepLevels | null {
	if (levelDraftProblems(item, drafts).length > 0) return null
	return {
		locationId,
		itemId: item.itemId,
		stationId: drafts.stationId,
		weekdays: drafts.weekdays.map((text) => {
			const clean = text.trim()
			return clean === ''
				? null
				: levelQuantity(clean, item.countUnit, item.baseUnit, item.units)
		}),
		expectedVersion: item.version,
	}
}

/** The task's unit for showing quantities: how the item is counted. */
export function prepUnit(task: Pick<PrepTask, 'countUnit'>): UnitRef {
	return task.countUnit
}

/** `POST /prep/tasks/:id/done` from the record-a-batch form's body. */
export function doneBody(
	task: Pick<PrepTask, 'version'>,
	batch: { clientId: string; made: DoneTask['made']; note?: string },
): DoneTask {
	return {
		expectedVersion: task.version,
		clientId: batch.clientId,
		made: batch.made,
		...(batch.note ? { note: batch.note } : {}),
	}
}
