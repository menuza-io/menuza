import { printerHealth, readPrinterRoutes } from '@repo/common/print-devices'
import {
	buildLabelDoc,
	formatLabelTime,
	type TicketWidthMm,
} from '@repo/common/print-ticket'
import { useByInstant, type LabelResult } from '@repo/inventory'
import {
	invItems,
	printDevices,
	type PrintDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { printingEnabled } from '../lib/print-switches.ts'
import { assertLocationAllowed, notFound } from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { resolveLocationTime } from './inventory-location-settings.ts'
import { assertUseByEnabled } from './inventory-lots-service.ts'
import { queueJob } from './print-service.ts'

/**
 * Food-safety labels (#523) through the one cloud print path of PR #578: the
 * label is a ticket document (`buildLabelDoc`) queued with `queueJob` to a
 * cloud printer at the location that is marked as printing labels. With no
 * label printer online the answer carries the label's words and the tablet
 * prints it through its own dialog, as it does for a receipt.
 *
 * Use-by is the made (or opened) time plus the item's shelf life, shown in the
 * location's time zone. Labels carry no money and no phone number.
 */

/** A tablet's clock may be this far behind the node's when it prints a label. */
const MADE_AT_WINDOW_MS = 2 * 24 * 60 * 60_000

/** The label printers of a location that are ready now, oldest first. */
async function readyLabelPrinters(
	db: TenantDatabase,
	locationId: string,
	now: number,
): Promise<PrintDevice[]> {
	const rows = await db
		.select()
		.from(printDevices)
		.where(
			and(
				eq(printDevices.locationId, locationId),
				isNull(printDevices.revokedAt),
			),
		)
		.orderBy(asc(printDevices.createdAt), asc(printDevices.id))
	return rows.filter(
		(device) =>
			readPrinterRoutes(device.routes).labels &&
			printerHealth(device, now) === 'online',
	)
}

export async function printItemLabel(
	db: TenantDatabase,
	input: {
		caller: InventoryCaller
		locationId: string
		itemId: string
		kind: 'made' | 'opened'
		copies: number
		quantityLabel?: string | null
		/** The tablet's clock; clamped to the last two days and never the future. */
		madeAt?: number
		/** The signed-in person's name, printed as "By". */
		madeBy: string | null
		requestId: string
		now?: number
	},
): Promise<LabelResult> {
	assertUseByEnabled(input.caller)
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const now = input.now ?? Date.now()
	const item = await db
		.select()
		.from(invItems)
		.where(eq(invItems.id, input.itemId))
		.get()
	if (!item || item.archivedAt !== null) throw notFound()
	const time = await resolveLocationTime(db, input.locationId)
	const timeZone = time.timeZone ?? 'UTC'
	const madeAt = Math.max(
		now - MADE_AT_WINDOW_MS,
		Math.min(input.madeAt ?? now, now),
	)
	const useByAt =
		item.shelfLifeHours === null
			? null
			: useByInstant(madeAt, item.shelfLifeHours)
	const madeBy = input.madeBy?.trim() ? input.madeBy.trim().slice(0, 30) : null
	const label = {
		itemId: item.id,
		nameEn: item.name,
		nameAr: item.nameAr,
		kind: input.kind,
		madeAt,
		useByAt,
		madeAtLabel: formatLabelTime(madeAt, timeZone),
		useByLabel: useByAt === null ? null : formatLabelTime(useByAt, timeZone),
		madeBy,
		quantityLabel: input.quantityLabel?.trim() || null,
		storageNote: item.storageNote,
		timeZone,
		copies: input.copies,
	}

	let jobs = 0
	let printed = false
	if (await printingEnabled(input.caller.orgId)) {
		const printer = (await readyLabelPrinters(db, input.locationId, now))[0]
		if (printer) {
			const doc = buildLabelDoc({
				nameEn: label.nameEn,
				nameAr: label.nameAr,
				kind: label.kind,
				madeAtLabel: label.madeAtLabel,
				useByLabel: label.useByLabel,
				madeBy: label.madeBy,
				quantityLabel: label.quantityLabel,
				storageNote: label.storageNote,
				widthMm: printer.widthMm as TicketWidthMm,
				copies: label.copies,
			})
			const id = await queueJob(db, printer, {
				sourceType: 'label',
				sourceId: item.id,
				kind: 'label',
				dedupeKey: `label:${input.requestId}`,
				doc,
			})
			// A repeat of the same press is already queued: it still counts as printed.
			jobs = id ? 1 : 0
			printed = true
		}
	}
	return { printed, jobs, label }
}
