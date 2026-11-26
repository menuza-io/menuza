import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import {
	buildClockSlipDoc,
	buildShiftReportDoc,
} from '@repo/common/print-ticket'
import {
	posDevices,
	posShifts,
	printDevices,
	printJobs,
	timeEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { queueJob } from './print-service.ts'

/** A printer that stays quiet this long drops the automatic job (#278). */
export const AUTO_PRINT_WAIT_MS = 10 * 60 * 1000

export type AutoPrintMode = 'off' | 'browser' | 'queued'

async function printersAt(db: TenantDatabase, locationId: string | null) {
	if (!locationId) return []
	return db
		.select()
		.from(printDevices)
		.where(
			and(
				eq(printDevices.locationId, locationId),
				isNull(printDevices.revokedAt),
			),
		)
}

/**
 * Queues the Z report when the terminal asks for it. A missing or failing
 * printer never throws: the drawer is already closed.
 */
export async function queueShiftReportPrint(
	db: TenantDatabase,
	input: {
		deviceId: string
		locationId: string | null
		enabled: boolean
		shiftId: string
		businessDate: string
		terminal: string
		lines: ReadonlyArray<{ label: string; value: string }>
	},
): Promise<{ mode: AutoPrintMode }> {
	if (!input.enabled) {
		await db
			.update(posShifts)
			.set({ autoPrintStatus: 'skipped' })
			.where(eq(posShifts.id, input.shiftId))
		return { mode: 'off' }
	}
	try {
		const printers = await printersAt(db, input.locationId)
		if (printers.length === 0) {
			await db
				.update(posShifts)
				.set({ autoPrintStatus: 'browser' })
				.where(eq(posShifts.id, input.shiftId))
			return { mode: 'browser' }
		}
		const doc = buildShiftReportDoc({
			businessDate: input.businessDate,
			terminal: input.terminal,
			lines: input.lines,
		})
		const printer = printers[0]!
		const jobId = await queueJob(db, printer, {
			sourceType: 'pos_shift',
			sourceId: input.shiftId,
			kind: 'receipt',
			dedupeKey: 'auto-close',
			doc,
		})
		await db
			.update(posShifts)
			.set({
				autoPrintJobId: jobId,
				autoPrintStatus: 'queued',
				autoPrintedAt: Date.now(),
			})
			.where(eq(posShifts.id, input.shiftId))
		return { mode: 'queued' }
	} catch (error) {
		console.error(
			'Shift report print failed',
			input.shiftId,
			error instanceof Error ? error.message : error,
		)
		await db
			.update(posShifts)
			.set({ autoPrintStatus: 'queued' })
			.where(eq(posShifts.id, input.shiftId))
			.catch(() => {})
		return { mode: 'queued' }
	}
}

/** Clock slip. The document is built without a pay rate. Never throws. */
export async function queueClockSlipPrint(
	db: TenantDatabase,
	input: {
		deviceId: string
		enabled: boolean
		entryId: string
		firstName: string
		action: 'in' | 'out'
		atLabel: string
		shiftTotalLabel?: string | null
	},
): Promise<{ mode: AutoPrintMode }> {
	if (!input.enabled) {
		await db
			.update(timeEntries)
			.set({ slipPrintStatus: 'skipped' })
			.where(eq(timeEntries.id, input.entryId))
		return { mode: 'off' }
	}
	try {
		const [device] = await db
			.select({ locationId: posDevices.locationId })
			.from(posDevices)
			.where(eq(posDevices.id, input.deviceId))
			.limit(1)
		const printers = await printersAt(db, device?.locationId ?? null)
		if (printers.length === 0) {
			await db
				.update(timeEntries)
				.set({ slipPrintStatus: 'browser' })
				.where(eq(timeEntries.id, input.entryId))
			return { mode: 'browser' }
		}
		const doc = buildClockSlipDoc({
			firstName: input.firstName,
			action: input.action,
			atLabel: input.atLabel,
			shiftTotalLabel: input.shiftTotalLabel,
		})
		const jobId = await queueJob(db, printers[0]!, {
			sourceType: 'time_entry',
			sourceId: input.entryId,
			kind: 'receipt',
			dedupeKey: `auto-${input.action}`,
			doc,
		})
		await db
			.update(timeEntries)
			.set({
				slipPrintJobId: jobId,
				slipPrintStatus: 'queued',
				slipPrintedAt: Date.now(),
			})
			.where(eq(timeEntries.id, input.entryId))
		return { mode: 'queued' }
	} catch (error) {
		console.error(
			'Clock slip print failed',
			input.entryId,
			error instanceof Error ? error.message : error,
		)
		return { mode: 'queued' }
	}
}

/**
 * Automatic jobs still waiting after 10 minutes are dropped. Closing and
 * clocking have already finished.
 */
export async function expireStaleAutoPrints(
	db: TenantDatabase,
	now = Date.now(),
): Promise<{ dropped: number }> {
	const cutoff = now - AUTO_PRINT_WAIT_MS
	const stale = await db
		.select({
			id: printJobs.id,
			sourceType: printJobs.sourceType,
			sourceId: printJobs.sourceId,
		})
		.from(printJobs)
		.where(
			and(
				inArray(printJobs.sourceType, ['pos_shift', 'time_entry']),
				inArray(printJobs.status, ['queued', 'offered']),
				lt(printJobs.createdAt, cutoff),
			),
		)
	for (const job of stale) {
		await db
			.update(printJobs)
			.set({ status: 'cancelled', failedReason: 'printer_offline_timeout' })
			.where(eq(printJobs.id, job.id))
		if (job.sourceType === 'pos_shift') {
			await db
				.update(posShifts)
				.set({ autoPrintStatus: 'dropped' })
				.where(eq(posShifts.id, job.sourceId))
		} else {
			await db
				.update(timeEntries)
				.set({ slipPrintStatus: 'dropped' })
				.where(eq(timeEntries.id, job.sourceId))
		}
	}
	return { dropped: stale.length }
}
