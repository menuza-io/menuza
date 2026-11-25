import {
	and,
	asc,
	db,
	eq,
	gte,
	isNotNull,
	isNull,
	LocationOrderingPause,
	lte,
	or,
	sql,
} from '@repo/database'

/**
 * The ONE ordering pause history (#176, #405), in `LocationOrderingPause`.
 * `applyOrderingControl` is the only writer of staff pauses: a pause opens a
 * row, a resume closes it, a new pause closes the one it replaces, and a pause
 * that ran out by itself is closed at its own planned end the next time
 * anything reads (`closeExpiredPauses`), so no timer is needed. Busy mode
 * never writes a row (orders still arrive). Times only: no guest data.
 */

export type PauseSource = 'app' | 'station' | 'bulk' | 'hours_edit'
export type PauseEndedBy = 'member' | 'station' | 'auto_expiry' | 'replaced' | 'window'

type PauseRow = typeof LocationOrderingPause.$inferSelect

/**
 * Closes the pauses that reached their planned end, at that end (not at the
 * time somebody noticed). Safe to call on every read.
 */
export async function closeExpiredPauses(
	organizationId: string,
	now: Date,
): Promise<void> {
	await db
		.update(LocationOrderingPause)
		// An expired pause ended at its own planned end: a copy of that column.
		.set({
			endedAt: sql`${LocationOrderingPause.plannedUntil}`,
			endedBy: 'auto_expiry',
		})
		.where(
			and(
				eq(LocationOrderingPause.organizationId, organizationId),
				eq(LocationOrderingPause.kind, 'pause'),
				isNull(LocationOrderingPause.endedAt),
				isNotNull(LocationOrderingPause.plannedUntil),
				lte(LocationOrderingPause.plannedUntil, now),
			),
		)
}

/** Opens a pause row, closing the one in force (a pause replaces a pause). */
export async function openPauseRow(input: {
	organizationId: string
	locationId: string
	startedAt: Date
	plannedUntil: Date | null
	startedBy: string | null
	source: PauseSource
}): Promise<void> {
	const [open] = await db
		.select()
		.from(LocationOrderingPause)
		.where(
			and(
				eq(LocationOrderingPause.locationId, input.locationId),
				eq(LocationOrderingPause.kind, 'pause'),
				isNull(LocationOrderingPause.endedAt),
			),
		)
		.limit(1)
	const closing = open ? closeStatement(open, input.startedAt, 'replaced') : null
	const insert = db.insert(LocationOrderingPause).values({
		organizationId: input.organizationId,
		locationId: input.locationId,
		kind: 'pause',
		startedAt: input.startedAt,
		plannedUntil: input.plannedUntil,
		startedBy: input.startedBy,
		source: input.source,
	})
	// One batch: the old pause ends and the new one starts together.
	if (closing) await db.batch([closing, insert])
	else await insert
}

function closeStatement(row: PauseRow, now: Date, endedBy: PauseEndedBy) {
	// A pause past its planned end ended there, whoever touches it now.
	const expired = row.plannedUntil && row.plannedUntil.getTime() <= now.getTime()
	return db
		.update(LocationOrderingPause)
		.set({
			endedAt: expired ? row.plannedUntil : now,
			endedBy: expired ? 'auto_expiry' : endedBy,
		})
		.where(eq(LocationOrderingPause.id, row.id))
}

/** Closes the pause in force at a location (a resume). Nothing open: nothing to do. */
export async function closePauseRow(input: {
	locationId: string
	now: Date
	endedBy: PauseEndedBy
}): Promise<void> {
	const [open] = await db
		.select()
		.from(LocationOrderingPause)
		.where(
			and(
				eq(LocationOrderingPause.locationId, input.locationId),
				eq(LocationOrderingPause.kind, 'pause'),
				isNull(LocationOrderingPause.endedAt),
			),
		)
		.limit(1)
	if (open) await closeStatement(open, input.now, input.endedBy)
}

/**
 * A pause already in force when the history began (the location row says it
 * is paused, no row says so) is given a row from the time it started, so
 * pauses running at deploy time are not lost.
 */
export async function backfillOpenPause(input: {
	organizationId: string
	locationId: string
	pausedAt: Date | null
	pausedUntil: Date | null
	now: Date
}): Promise<void> {
	if (!input.pausedAt) return
	if (input.pausedUntil && input.pausedUntil.getTime() <= input.now.getTime()) {
		// Already ran out: the closed row covers its whole run.
	}
	const existing = await db
		.select({ id: LocationOrderingPause.id })
		.from(LocationOrderingPause)
		.where(
			and(
				eq(LocationOrderingPause.locationId, input.locationId),
				eq(LocationOrderingPause.kind, 'pause'),
				eq(LocationOrderingPause.startedAt, input.pausedAt),
			),
		)
		.limit(1)
	if (existing.length > 0) return
	const ended =
		input.pausedUntil && input.pausedUntil.getTime() <= input.now.getTime()
	await db
		.insert(LocationOrderingPause)
		.values({
			organizationId: input.organizationId,
			locationId: input.locationId,
			kind: 'pause',
			startedAt: input.pausedAt,
			plannedUntil: input.pausedUntil,
			endedAt: ended ? input.pausedUntil : null,
			endedBy: ended ? 'auto_expiry' : null,
			startedBy: null,
			source: 'app',
		})
		.onConflictDoNothing()
}

/** Writes closed `closure` rows: scheduled hours taken away at short notice. */
export async function recordClosures(input: {
	organizationId: string
	locationId: string
	windows: ReadonlyArray<{ from: number; to: number }>
	startedBy: string | null
}): Promise<void> {
	if (input.windows.length === 0) return
	await db.insert(LocationOrderingPause).values(
		input.windows.map((window) => ({
			organizationId: input.organizationId,
			locationId: input.locationId,
			kind: 'closure',
			startedAt: new Date(window.from),
			plannedUntil: new Date(window.to),
			endedAt: new Date(window.to),
			endedBy: 'window',
			startedBy: input.startedBy,
			source: 'hours_edit',
		})),
	)
}

/** The history rows that touch `[from, to]` (milliseconds), oldest first. */
export async function loadPauseHistory(
	organizationId: string,
	range: { from: Date; to: Date },
	options: { locationId?: string } = {},
): Promise<PauseRow[]> {
	await closeExpiredPauses(organizationId, new Date())
	return db
		.select()
		.from(LocationOrderingPause)
		.where(
			and(
				eq(LocationOrderingPause.organizationId, organizationId),
				...(options.locationId
					? [eq(LocationOrderingPause.locationId, options.locationId)]
					: []),
				lte(LocationOrderingPause.startedAt, range.to),
				or(
					isNull(LocationOrderingPause.endedAt),
					gte(LocationOrderingPause.endedAt, range.from),
				)!,
			),
		)
		.orderBy(asc(LocationOrderingPause.startedAt))
}
