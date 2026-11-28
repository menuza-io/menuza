import { randomUUID } from 'node:crypto'
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lte,
	or,
	sql,
} from 'drizzle-orm'
import {
	formatPrintRef,
	generatePrinterPassword,
	PRINT_JOB_MAX_AGE_MS,
	PRINT_MAX_ATTEMPTS,
	PRINT_REOFFER_MS,
	printerHealth,
	printerHealthReason,
	readPrinterRoutes,
	routeKitchenTicket,
	routeReceipt,
	type PrinterHealth,
	type PrinterRoutes,
	type PrinterSetup,
} from '@repo/common/print-devices'
import {
	buildDrawerJob,
	buildKitchenTicket,
	buildReceipt,
	buildTestTicket,
	type KitchenTicketInput,
	type TicketDoc,
	type TicketWidthMm,
} from '@repo/common/print-ticket'
import { type PrinterReport } from '@repo/common/print-protocols'
import { resolveTickets, printAllowed } from '@repo/common/ticket-config'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { kitchenLineName } from '@repo/common/kitchen-ticket'
import {
	printDevices,
	printJobs,
	restaurantOrders,
	posOrders,
	type PrintDevice,
	type PrintJob,
	type PrintJobKind,
	type TenantDatabase,
} from '@repo/tenant-db'
import { hashPrinterPassword } from '../lib/print-auth.ts'
import { printingEnabled } from '../lib/print-switches.ts'
import { logoBitmapFor } from '../lib/logo-bitmap.ts'
import { projectTicketForPrint } from './kds-service.ts'
import { loadReceiptForPrint, loadPrintContext } from './print-source.ts'

/**
 * Cloud printers (#117, #426). Printers belong to one location; a job belongs
 * to one printer. Every query below that takes a job also takes the printer, so
 * a printer can never see or finish another printer's (or another location's)
 * job.
 */

export type PrinterView = {
	id: string
	ref: string
	locationId: string
	name: string
	protocol: PrintDevice['protocol']
	widthMm: number
	copies: number
	routes: PrinterRoutes
	health: PrinterHealth
	healthReason: string | null
	lastSeenAt: number | null
	status: string
	lastTestAt: number | null
	lastTestResult: string | null
	/** Jobs that were offered the most times and never acknowledged. */
	flaggedJobs: number
	createdAt: number
	revokedAt: number | null
}

function view(
	orgId: string,
	device: PrintDevice,
	now: number,
	flagged: number,
): PrinterView {
	const health = printerHealth(device, now)
	return {
		id: device.id,
		ref: formatPrintRef(orgId, device.id),
		locationId: device.locationId,
		name: device.name,
		protocol: device.protocol,
		widthMm: device.widthMm,
		copies: device.copies,
		routes: readPrinterRoutes(device.routes),
		health,
		healthReason: printerHealthReason(health),
		lastSeenAt: device.lastSeenAt,
		status: device.status,
		lastTestAt: device.lastTestAt,
		lastTestResult: device.lastTestResult,
		flaggedJobs: flagged,
		createdAt: device.createdAt,
		revokedAt: device.revokedAt,
	}
}

async function flaggedCounts(db: TenantDatabase): Promise<Map<string, number>> {
	const rows = await db
		.select({ deviceId: printJobs.deviceId, count: sql<number>`count(*)` })
		.from(printJobs)
		.where(eq(printJobs.status, 'flagged'))
		.groupBy(printJobs.deviceId)
	return new Map(rows.map((row) => [row.deviceId, Number(row.count)]))
}

/** Printers an operator may see: all, or only those at their locations. */
export async function listPrinters(
	db: TenantDatabase,
	orgId: string,
	locationIds: readonly string[] | null,
	now = Date.now(),
): Promise<PrinterView[]> {
	const rows = await db
		.select()
		.from(printDevices)
		.where(isNull(printDevices.revokedAt))
		.orderBy(asc(printDevices.name))
	const flagged = await flaggedCounts(db)
	return rows
		.filter(
			(row) => locationIds === null || locationIds.includes(row.locationId),
		)
		.map((row) => view(orgId, row, now, flagged.get(row.id) ?? 0))
}

export async function getPrinter(
	db: TenantDatabase,
	printerId: string,
): Promise<PrintDevice | null> {
	const [row] = await db
		.select()
		.from(printDevices)
		.where(eq(printDevices.id, printerId))
		.limit(1)
	return row ?? null
}

/**
 * Adds a printer. The password is returned once and never stored: only a keyed
 * hash is. The operator enters the address and the password in the printer's
 * cloud printing settings.
 */
export async function createPrinter(
	db: TenantDatabase,
	orgId: string,
	setup: PrinterSetup,
	createdBy: string,
): Promise<{ printer: PrinterView; password: string }> {
	const id = randomUUID()
	const password = generatePrinterPassword()
	const ref = formatPrintRef(orgId, id)
	const [row] = await db
		.insert(printDevices)
		.values({
			id,
			locationId: setup.locationId,
			name: setup.name,
			secretHash: hashPrinterPassword(ref, password),
			protocol: setup.protocol,
			widthMm: setup.widthMm,
			copies: setup.copies,
			routes: setup.routes,
			createdBy,
		})
		.returning()
	return { printer: view(orgId, row!, Date.now(), 0), password }
}

export async function updatePrinter(
	db: TenantDatabase,
	orgId: string,
	printerId: string,
	patch: {
		name?: string
		widthMm?: 58 | 80
		copies?: number
		routes?: PrinterRoutes
	},
): Promise<PrinterView | null> {
	const [row] = await db
		.update(printDevices)
		.set({
			...(patch.name !== undefined ? { name: patch.name } : {}),
			...(patch.widthMm !== undefined ? { widthMm: patch.widthMm } : {}),
			...(patch.copies !== undefined ? { copies: patch.copies } : {}),
			...(patch.routes !== undefined ? { routes: patch.routes } : {}),
		})
		.where(and(eq(printDevices.id, printerId), isNull(printDevices.revokedAt)))
		.returning()
	return row ? view(orgId, row, Date.now(), 0) : null
}

/** A new password for the same printer: the old one stops working at once. */
export async function resetPrinterPassword(
	db: TenantDatabase,
	orgId: string,
	printerId: string,
): Promise<{ printer: PrinterView; password: string } | null> {
	const password = generatePrinterPassword()
	const ref = formatPrintRef(orgId, printerId)
	const [row] = await db
		.update(printDevices)
		.set({ secretHash: hashPrinterPassword(ref, password) })
		.where(and(eq(printDevices.id, printerId), isNull(printDevices.revokedAt)))
		.returning()
	return row ? { printer: view(orgId, row, Date.now(), 0), password } : null
}

/** Removes a printer: it stops getting jobs at once and what waited is cancelled. */
export async function revokePrinter(
	db: TenantDatabase,
	printerId: string,
	revokedBy: string,
	now = Date.now(),
): Promise<boolean> {
	const [row] = await db
		.update(printDevices)
		.set({ revokedAt: now, revokedBy })
		.where(and(eq(printDevices.id, printerId), isNull(printDevices.revokedAt)))
		.returning({ id: printDevices.id })
	if (!row) return false
	await db
		.update(printJobs)
		.set({ status: 'cancelled', failedReason: 'printer_removed' })
		.where(
			and(
				eq(printJobs.deviceId, printerId),
				inArray(printJobs.status, ['queued', 'offered']),
			),
		)
	return true
}

// ---------------------------------------------------------------------------
// The printer side: poll, fetch, acknowledge
// ---------------------------------------------------------------------------

/** Records that the printer asked, and what it said about itself. */
export async function recordPoll(
	db: TenantDatabase,
	device: PrintDevice,
	report: PrinterReport,
	now = Date.now(),
): Promise<void> {
	await db
		.update(printDevices)
		.set({
			lastSeenAt: now,
			// A poll that says nothing keeps the last status.
			...(report.status !== 'unknown'
				? { status: report.status, statusAt: now }
				: {}),
		})
		.where(eq(printDevices.id, device.id))
}

/**
 * The next job this printer should print, claimed for this offer. A job is
 * offered when it is new, or when its last offer went unanswered for 30
 * seconds, at most 5 times; after that it is flagged for the operator and never
 * offered again. A job already acknowledged is never offered.
 */
export async function claimNextJob(
	db: TenantDatabase,
	device: PrintDevice,
	now = Date.now(),
): Promise<PrintJob | null> {
	const stale = now - PRINT_REOFFER_MS
	// Out of offers: flag it.
	await db
		.update(printJobs)
		.set({ status: 'flagged', failedReason: 'not_acknowledged' })
		.where(
			and(
				eq(printJobs.deviceId, device.id),
				eq(printJobs.status, 'offered'),
				gte(printJobs.attempts, PRINT_MAX_ATTEMPTS),
				lte(printJobs.offeredAt, stale),
			),
		)
	// A ticket from hours ago is not printed late: it would mislead the kitchen.
	await db
		.update(printJobs)
		.set({ status: 'cancelled', failedReason: 'expired' })
		.where(
			and(
				eq(printJobs.deviceId, device.id),
				inArray(printJobs.status, ['queued', 'offered']),
				lte(printJobs.createdAt, now - PRINT_JOB_MAX_AGE_MS),
			),
		)
	for (let tries = 0; tries < 3; tries++) {
		const [candidate] = await db
			.select()
			.from(printJobs)
			.where(
				and(
					eq(printJobs.deviceId, device.id),
					or(
						eq(printJobs.status, 'queued'),
						and(
							eq(printJobs.status, 'offered'),
							lte(printJobs.offeredAt, stale),
							sql`${printJobs.attempts} < ${PRINT_MAX_ATTEMPTS}`,
						),
					),
				),
			)
			.orderBy(asc(printJobs.createdAt))
			.limit(1)
		if (!candidate) return null
		// Compare and set: two polls at once never claim the same offer.
		const [claimed] = await db
			.update(printJobs)
			.set({
				status: 'offered',
				attempts: sql`${printJobs.attempts} + 1`,
				offeredAt: now,
			})
			.where(
				and(
					eq(printJobs.id, candidate.id),
					eq(printJobs.deviceId, device.id),
					or(
						eq(printJobs.status, 'queued'),
						and(
							eq(printJobs.status, 'offered'),
							lte(printJobs.offeredAt, stale),
						),
					),
					eq(printJobs.attempts, candidate.attempts),
				),
			)
			.returning()
		if (claimed) return claimed
	}
	return null
}

/** One of this printer's jobs that is still waiting to print, or null. */
export async function jobToFetch(
	db: TenantDatabase,
	device: PrintDevice,
	jobId: string,
): Promise<PrintJob | null> {
	const [row] = await db
		.select()
		.from(printJobs)
		.where(and(eq(printJobs.id, jobId), eq(printJobs.deviceId, device.id)))
		.limit(1)
	return row && row.status === 'offered' ? row : null
}

export type AckResult = 'printed' | 'already_printed' | 'failed' | 'unknown'

/**
 * The printer says it printed the job, or why it could not. A job that already
 * printed stays printed (an acknowledgement sent twice changes nothing), so a
 * job prints once.
 */
export async function acknowledgeJob(
	db: TenantDatabase,
	device: PrintDevice,
	jobId: string,
	outcome: { ok: true } | { ok: false; reason: string },
	now = Date.now(),
): Promise<AckResult> {
	const [job] = await db
		.select()
		.from(printJobs)
		.where(and(eq(printJobs.id, jobId), eq(printJobs.deviceId, device.id)))
		.limit(1)
	if (!job) return 'unknown'
	if (job.status === 'printed') return 'already_printed'
	if (outcome.ok) {
		const [done] = await db
			.update(printJobs)
			.set({ status: 'printed', printedAt: now, failedReason: null })
			.where(
				and(
					eq(printJobs.id, jobId),
					eq(printJobs.deviceId, device.id),
					inArray(printJobs.status, ['offered', 'queued', 'flagged']),
				),
			)
			.returning({ id: printJobs.id })
		if (!done) return 'unknown'
		if (job.kind === 'test' || job.kind === 'drawer') {
			await db
				.update(printDevices)
				.set({ lastTestAt: now, lastTestResult: 'ok' })
				.where(eq(printDevices.id, device.id))
		}
		return 'printed'
	}
	// A failed print stays on offer (it comes round again after 30 seconds, up
	// to the limit); the reason is kept for the operator.
	await db
		.update(printJobs)
		.set({ failedReason: outcome.reason.slice(0, 80) })
		.where(and(eq(printJobs.id, jobId), eq(printJobs.deviceId, device.id)))
	if (job.kind === 'test' || job.kind === 'drawer') {
		await db
			.update(printDevices)
			.set({ lastTestResult: outcome.reason.slice(0, 80) })
			.where(eq(printDevices.id, device.id))
	}
	return 'failed'
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export async function queueJob(
	db: TenantDatabase,
	device: Pick<PrintDevice, 'id' | 'locationId'>,
	input: {
		sourceType: string
		sourceId: string
		kind: PrintJobKind
		dedupeKey: string
		doc: TicketDoc
	},
): Promise<string | null> {
	const [row] = await db
		.insert(printJobs)
		.values({
			deviceId: device.id,
			locationId: device.locationId,
			sourceType: input.sourceType,
			sourceId: input.sourceId,
			kind: input.kind,
			dedupeKey: input.dedupeKey,
			payload: input.doc,
		})
		.onConflictDoNothing()
		.returning({ id: printJobs.id })
	return row?.id ?? null
}

async function livePrinters(db: TenantDatabase, locationId: string) {
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

export type PrintTrigger =
	| { kind: 'kitchen'; dedupeKey: string; reprint?: boolean }
	| { kind: 'receipt'; dedupeKey: string; reprint?: boolean }

/**
 * Queues the jobs one order produces (#117): the kitchen ticket split over the
 * printers by station, or the guest receipt. Runs after the order's own
 * transaction has committed and never throws into it. The unique key on
 * (printer, source, kind, trigger) makes a hook that runs twice queue once.
 */
export async function queueOrderPrint(
	db: TenantDatabase,
	input: {
		orgId: string
		locationId: string
		source: 'online' | 'pos'
		orderId: string
		trigger: PrintTrigger
		now?: number
	},
): Promise<{ queued: number; printers: number; reason?: string }> {
	if (!(await printingEnabled(input.orgId))) {
		return { queued: 0, printers: 0, reason: 'printing_off' }
	}
	const printers = await livePrinters(db, input.locationId)
	if (printers.length === 0) return { queued: 0, printers: 0 }
	const context = await loadPrintContext(input.orgId, input.locationId)
	const tickets = resolveTickets(context?.tickets)
	const sourceType =
		input.source === 'online' ? 'restaurant_order' : 'pos_order'
	let queued = 0

	if (input.trigger.kind === 'kitchen') {
		const projected = await projectTicketForPrint(
			db,
			input.orgId,
			input.locationId,
			input.source,
			input.orderId,
		)
		if (!projected) return { queued: 0, printers: printers.length }
		const { ticket, stationNames } = projected
		const orderType = printOrderType(ticket)
		if (
			!printAllowed(
				tickets,
				orderType === 'takeaway'
					? 'takeaway'
					: orderType === 'pickup'
						? 'pickup'
						: orderType,
			)
		) {
			return {
				queued: 0,
				printers: printers.length,
				reason: 'dine_in_left_out',
			}
		}
		const routes = routeKitchenTicket({
			locationId: input.locationId,
			lines: ticket.lines.map((line) => ({
				stationIds: line.stationIds ?? [line.stationId],
			})),
			printers: printers.map((device) => ({
				id: device.id,
				locationId: device.locationId,
				revokedAt: device.revokedAt,
				routes: readPrinterRoutes(device.routes),
			})),
		})
		const extra = await kitchenExtras(
			db,
			input.orgId,
			input.locationId,
			input.source,
			input.orderId,
		)
		for (const route of routes) {
			const device = printers.find((p) => p.id === route.printerId)
			if (!device) continue
			const doc = buildKitchenTicket({
				ticket: kitchenInput({
					ticket,
					lineIndexes: route.lineIndexes,
					station:
						route.partial && ticket.lines[route.lineIndexes[0] ?? 0]
							? (stationNames.get(
									ticket.lines[route.lineIndexes[0]!]!.stationId,
								) ?? null)
							: null,
					orderType,
					timeZone: context?.timeZone ?? extra.timeZone,
					locale: context?.defaultLocale ?? 'en',
					guestFirstName: extra.guestFirstName,
					deliveryAddress: readPrinterRoutes(device.routes).deliveryAddress
						? extra.deliveryAddress
						: null,
					reprint: input.trigger.reprint === true,
				}),
				tickets,
				widthMm: device.widthMm as TicketWidthMm,
				copies: device.copies,
				locale: context?.defaultLocale ?? 'en',
			})
			if (
				await queueJob(db, device, {
					sourceType,
					sourceId: input.orderId,
					kind: 'kitchen',
					dedupeKey: input.trigger.dedupeKey,
					doc,
				})
			)
				queued++
		}
		return { queued, printers: printers.length }
	}

	const targets = routeReceipt({
		locationId: input.locationId,
		printers: printers.map((device) => ({
			id: device.id,
			locationId: device.locationId,
			revokedAt: device.revokedAt,
			routes: readPrinterRoutes(device.routes),
		})),
	})
	if (targets.length === 0) return { queued: 0, printers: printers.length }
	const receipt = await loadReceiptForPrint(db, {
		orgId: input.orgId,
		locationId: input.locationId,
		source: input.source,
		orderId: input.orderId,
		context,
		reprint: input.trigger.reprint === true,
	})
	if (!receipt) return { queued: 0, printers: printers.length }
	for (const id of targets) {
		const device = printers.find((p) => p.id === id)
		if (!device) continue
		const doc = buildReceipt({
			receipt: receipt.receipt,
			tickets,
			extras: {
				config: tickets.extras,
				targets: receipt.extras.targets,
				logo: await logoBitmapFor(
					receipt.extras.logoUrl,
					device.widthMm as TicketWidthMm,
				),
			},
			widthMm: device.widthMm as TicketWidthMm,
			copies: device.copies,
			locale: context?.defaultLocale ?? 'en',
		})
		if (
			await queueJob(db, device, {
				sourceType,
				sourceId: input.orderId,
				kind: 'receipt',
				dedupeKey: input.trigger.dedupeKey,
				doc,
			})
		)
			queued++
	}
	return { queued, printers: printers.length }
}

function printOrderType(ticket: {
	fulfillment: string
	driveThrough?: boolean
}): KitchenTicketInput['orderType'] {
	if (ticket.driveThrough) return 'drive_through'
	if (ticket.fulfillment === 'dine_in') return 'dine_in'
	if (ticket.fulfillment === 'delivery') return 'delivery'
	return 'takeaway'
}

/** First name and delivery address, read from the order itself: never a phone number. */
async function kitchenExtras(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	source: 'online' | 'pos',
	orderId: string,
): Promise<{
	guestFirstName: string | null
	deliveryAddress: string | null
	timeZone: string
}> {
	if (source === 'online') {
		const [row] = await db
			.select({
				name: restaurantOrders.contactName,
				fulfillment: restaurantOrders.fulfillment,
				address: restaurantOrders.deliveryAddress,
				unit: restaurantOrders.deliveryUnit,
				city: restaurantOrders.deliveryCity,
				zone: restaurantOrders.locationTimezone,
			})
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.id, orderId),
					eq(restaurantOrders.orgId, orgId),
					eq(restaurantOrders.locationId, locationId),
				),
			)
			.limit(1)
		return {
			guestFirstName:
				row?.fulfillment === 'pickup' ? firstName(row.name) : null,
			deliveryAddress:
				row?.fulfillment === 'delivery' && row.address
					? [row.address, row.unit, row.city].filter(Boolean).join(', ')
					: null,
			timeZone: row?.zone || 'UTC',
		}
	}
	const [row] = await db
		.select({
			name: posOrders.guestName,
			zone: posOrders.pickupTimeZone,
		})
		.from(posOrders)
		.where(and(eq(posOrders.id, orderId), eq(posOrders.locationId, locationId)))
		.limit(1)
	return {
		guestFirstName: firstName(row?.name),
		deliveryAddress: null,
		timeZone: row?.zone || 'UTC',
	}
}

const firstName = (name: string | null | undefined): string | null => {
	const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
	return first ? first.slice(0, 20) : null
}

function kitchenInput(input: {
	ticket: Awaited<ReturnType<typeof projectTicketForPrint>> extends infer T
		? T extends { ticket: infer K }
			? K
			: never
		: never
	lineIndexes: number[]
	station: string | null
	orderType: KitchenTicketInput['orderType']
	timeZone: string
	locale: string
	guestFirstName: string | null
	deliveryAddress: string | null
	reprint: boolean
}): KitchenTicketInput {
	const { ticket } = input
	const time = new Intl.DateTimeFormat(
		input.locale === 'ar' ? 'ar-SA' : 'en-US',
		{
			dateStyle: 'short',
			timeStyle: 'short',
			timeZone: safeZone(input.timeZone),
		},
	)
	return {
		number: ticket.number,
		time: time.format(ticket.createdAt),
		orderType: input.orderType,
		tableLabel: ticket.tableLabel,
		guestFirstName: input.guestFirstName,
		dueTime: ticket.dueAt
			? new Intl.DateTimeFormat('en-US', {
					timeStyle: 'short',
					timeZone: safeZone(input.timeZone),
				}).format(ticket.dueAt)
			: null,
		deliveryAddress: input.deliveryAddress,
		stationName: input.station,
		utensilsRequested: ticket.utensilsRequested ?? null,
		largeOrderExtraMinutes: ticket.largeOrderExtraMinutes ?? null,
		largeOrder: ticket.largeOrder === true,
		paid: ticket.paid ?? null,
		guestAllergy: ticket.guestAllergy === true,
		checkId: ticket.checkId === true,
		testOrder: ticket.isTest === true,
		reprint: input.reprint,
		lines: input.lineIndexes.map((index) => {
			const line = ticket.lines[index]!
			return {
				quantity: line.quantity,
				name: kitchenLineName(
					line.name,
					line.kitchenName,
					input.locale,
					input.locale,
				),
				variant: line.variant,
				highlight:
					line.highlight && line.highlight !== 'none' ? line.highlight : null,
				note: line.instructions || null,
				courseName: line.courseName ?? null,
				held: line.held,
				options: line.options.map((option) => ({
					name: kitchenLineName(
						option.name,
						option.kitchenName,
						input.locale,
						input.locale,
					),
					quantity: option.quantity,
					groupName: option.groupName
						? getLocalizedMenuValue(
								option.groupName,
								input.locale,
								input.locale,
							)
						: null,
					highlight:
						option.highlight && option.highlight !== 'none'
							? option.highlight
							: null,
				})),
			}
		}),
	}
}

function safeZone(zone: string): string {
	try {
		new Intl.DateTimeFormat('en', { timeZone: zone })
		return zone
	} catch {
		return 'UTC'
	}
}

// ---------------------------------------------------------------------------
// Test print and open drawer (#426)
// ---------------------------------------------------------------------------

export type TestOutcome =
	| { ok: true; jobId: string }
	| { ok: false; reason: PrinterHealth; message: string }

/**
 * A test ticket or an open-drawer pulse, through the same queue as real
 * tickets. A printer that is disconnected, out of paper or has its cover open
 * answers with the reason at once instead of queueing a job that cannot print.
 */
export async function requestTest(
	db: TenantDatabase,
	device: PrintDevice,
	kind: 'test' | 'drawer',
	locationName: string,
	now = Date.now(),
): Promise<TestOutcome> {
	const health = printerHealth(device, now)
	if (health !== 'online') {
		return {
			ok: false,
			reason: health,
			message: printerHealthReason(health) ?? 'The printer is not ready.',
		}
	}
	const doc =
		kind === 'drawer'
			? buildDrawerJob(device.widthMm as TicketWidthMm)
			: buildTestTicket({
					printerName: device.name,
					locationName,
					widthMm: device.widthMm as TicketWidthMm,
					time: new Date(now).toISOString().replace('T', ' ').slice(0, 16),
				})
	const id = await queueJob(db, device, {
		sourceType: 'test',
		sourceId: device.id,
		kind,
		dedupeKey: `${kind}:${randomUUID()}`,
		doc,
	})
	return { ok: true, jobId: id! }
}

export async function jobStatus(
	db: TenantDatabase,
	printerId: string,
	jobId: string,
): Promise<{
	status: string
	reason: string | null
	printedAt: number | null
} | null> {
	const [row] = await db
		.select({
			status: printJobs.status,
			reason: printJobs.failedReason,
			printedAt: printJobs.printedAt,
		})
		.from(printJobs)
		.where(and(eq(printJobs.id, jobId), eq(printJobs.deviceId, printerId)))
		.limit(1)
	return row ?? null
}

/** Jobs an operator looks at: the flagged ones first, then the latest. */
export async function listJobs(
	db: TenantDatabase,
	locationIds: readonly string[] | null,
	filter: { sourceId?: string; flagged?: boolean },
) {
	const rows = await db
		.select({
			id: printJobs.id,
			deviceId: printJobs.deviceId,
			locationId: printJobs.locationId,
			kind: printJobs.kind,
			sourceType: printJobs.sourceType,
			sourceId: printJobs.sourceId,
			status: printJobs.status,
			attempts: printJobs.attempts,
			failedReason: printJobs.failedReason,
			createdAt: printJobs.createdAt,
			printedAt: printJobs.printedAt,
		})
		.from(printJobs)
		.where(
			and(
				filter.sourceId ? eq(printJobs.sourceId, filter.sourceId) : undefined,
				filter.flagged ? eq(printJobs.status, 'flagged') : undefined,
			),
		)
		.orderBy(desc(printJobs.createdAt))
		.limit(100)
	return rows.filter(
		(row) => locationIds === null || locationIds.includes(row.locationId),
	)
}

/** Whether the location has a live cloud printer: Station then skips the browser print dialog. */
export async function locationHasPrinter(
	db: TenantDatabase,
	locationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: printDevices.id })
		.from(printDevices)
		.where(
			and(
				eq(printDevices.locationId, locationId),
				isNull(printDevices.revokedAt),
			),
		)
		.limit(1)
	return Boolean(row)
}
