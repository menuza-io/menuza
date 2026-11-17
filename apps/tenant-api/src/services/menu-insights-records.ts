import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { distinctItemIds } from '@repo/common/item-pairs'
import { computeModifierAttach } from '@repo/common/modifier-attach'
import {
	POS_SALE_STATUSES,
	posSalesChannel,
	restaurantSalesChannel,
} from '@repo/common/sales-report-facts'
import {
	type ReportDefinition,
	type ReportRecord,
	referencedFieldIds,
	resolveTimeframeRange,
	type ReportSubject,
} from '@repo/reports'
import {
	posOrders,
	qrTabs,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { countedOrderCondition } from './report-records.ts'
import { parseSoldLines } from './item-sales.ts'
import { type SalesReportContext } from './sales-report-records.ts'

export const MENU_INSIGHTS_MAX_ROWS = 50_000

type SaleBundle = {
	occurredAt: Date
	locationId: string
	channel: string
	currency: string
	lines: ReturnType<typeof parseSoldLines>
	names: Map<string, string>
	optionNames: Map<string, string>
	modifierLines: Array<{
		itemId: string
		quantity: number
		options: Array<{
			optionId: string
			quantity: number
			salesMinor: number
			name: string
		}>
	}>
}

function localizedName(value: unknown): string {
	return typeof value === 'string' ? getLocalizedMenuValue(value) : ''
}

function readRestaurantModifierLines(raw: unknown) {
	const lines: SaleBundle['modifierLines'] = []
	let parsed = raw
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed)
		} catch {
			return lines
		}
	}
	if (!Array.isArray(parsed)) return lines
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue
		const line = entry as Record<string, unknown>
		const itemId = typeof line.itemId === 'string' ? line.itemId : ''
		const quantity =
			typeof line.quantity === 'number' && line.quantity > 0
				? Math.floor(line.quantity)
				: 0
		if (!itemId || quantity === 0) continue
		const options: SaleBundle['modifierLines'][0]['options'] = []
		for (const optionEntry of Array.isArray(line.options) ? line.options : []) {
			if (!optionEntry || typeof optionEntry !== 'object') continue
			const option = optionEntry as Record<string, unknown>
			const optionId =
				typeof option.optionId === 'string' ? option.optionId : ''
			const optionQuantity =
				typeof option.quantity === 'number' && option.quantity > 0
					? Math.floor(option.quantity)
					: 0
			if (!optionId || optionQuantity === 0) continue
			options.push({
				optionId,
				quantity: optionQuantity,
				salesMinor:
					typeof option.totalCents === 'number'
						? option.totalCents
						: typeof option.unitCents === 'number'
							? option.unitCents * optionQuantity
							: 0,
				name: localizedName(option.optionName ?? option.name),
			})
		}
		lines.push({ itemId, quantity, options })
	}
	return lines
}

function readPosModifierLines(raw: unknown) {
	const sold = parseSoldLines(raw, 'pos')
	const lines: SaleBundle['modifierLines'] = []
	let parsed = raw
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed)
		} catch {
			return { sold, lines }
		}
	}
	if (!Array.isArray(parsed)) return { sold, lines }
	const names = new Map<string, string>()
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue
		const line = entry as Record<string, unknown>
		const itemId = typeof line.itemId === 'string' ? line.itemId : ''
		if (itemId && typeof line.name === 'string') {
			names.set(itemId, getLocalizedMenuValue(line.name))
		}
		const quantity =
			typeof line.quantity === 'number' && line.quantity > 0
				? Math.floor(line.quantity)
				: 0
		if (!itemId || quantity === 0) continue
		const options: SaleBundle['modifierLines'][0]['options'] = []
		for (const optionEntry of Array.isArray(line.options) ? line.options : []) {
			if (!optionEntry || typeof optionEntry !== 'object') continue
			const option = optionEntry as Record<string, unknown>
			const optionId =
				typeof option.optionId === 'string' ? option.optionId : ''
			const optionQuantity =
				typeof option.quantity === 'number' && option.quantity > 0
					? Math.floor(option.quantity)
					: 0
			if (!optionId || optionQuantity === 0) continue
			options.push({
				optionId,
				quantity: optionQuantity,
				salesMinor:
					typeof option.unitCents === 'number'
						? option.unitCents * optionQuantity
						: 0,
				name: localizedName(option.name),
			})
		}
		lines.push({ itemId, quantity, options })
	}
	return { sold, lines, names }
}

function locationFilter(
	column: typeof restaurantOrders.locationId | typeof posOrders.locationId,
	locationIds: readonly string[] | null,
): SQL[] {
	if (locationIds === null) return []
	if (locationIds.length === 0) return [sql`0`]
	return [inArray(column, [...locationIds])]
}

async function loadSales(
	ctx: SalesReportContext,
	definition: ReportDefinition,
): Promise<{ sales: SaleBundle[]; truncated: boolean }> {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		ctx.now,
		definition.timeframe,
	)
	const end = Math.floor(range.end.getTime() / 1000)
	const sales: SaleBundle[] = []

	const webConditions: SQL[] = [
		eq(restaurantOrders.orgId, ctx.orgId),
		countedOrderCondition(),
		sql`${restaurantOrders.createdAt} <= ${end}`,
		or(isNull(qrTabs.id), eq(qrTabs.rungUpOnStation, false))!,
		...locationFilter(restaurantOrders.locationId, ctx.locationIds),
	]
	if (range.start) {
		webConditions.push(
			sql`${restaurantOrders.createdAt} >= ${Math.floor(range.start.getTime() / 1000)}`,
		)
	}
	const webRows = await ctx.db
		.select({
			createdAt: restaurantOrders.createdAt,
			locationId: restaurantOrders.locationId,
			source: restaurantOrders.source,
			dropId: restaurantOrders.dropId,
			currency: restaurantOrders.currency,
			lines: restaurantOrders.lines,
		})
		.from(restaurantOrders)
		.leftJoin(qrTabs, eq(qrTabs.id, restaurantOrders.tabId))
		.where(and(...webConditions))
		.orderBy(desc(restaurantOrders.createdAt))
		.limit(MENU_INSIGHTS_MAX_ROWS + 1)

	let truncated = webRows.length > MENU_INSIGHTS_MAX_ROWS
	const keptWeb = truncated ? webRows.slice(0, MENU_INSIGHTS_MAX_ROWS) : webRows

	for (const row of keptWeb) {
		if (!row.createdAt) continue
		const lines = parseSoldLines(row.lines, 'restaurant')
		if (lines.length === 0) continue
		const names = new Map<string, string>()
		const optionNames = new Map<string, string>()
		let parsed = row.lines
		if (typeof parsed === 'string') {
			try {
				parsed = JSON.parse(parsed)
			} catch {
				parsed = []
			}
		}
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (!entry || typeof entry !== 'object') continue
				const line = entry as Record<string, unknown>
				if (typeof line.itemId === 'string') {
					names.set(line.itemId, localizedName(line.itemName))
				}
				for (const option of Array.isArray(line.options) ? line.options : []) {
					if (!option || typeof option !== 'object') continue
					const o = option as Record<string, unknown>
					if (typeof o.optionId === 'string') {
						optionNames.set(o.optionId, localizedName(o.optionName))
					}
				}
			}
		}
		sales.push({
			occurredAt: row.createdAt,
			locationId: row.locationId,
			channel: restaurantSalesChannel({
				source: row.source,
				dropId: row.dropId,
			}),
			currency: row.currency.toUpperCase(),
			lines,
			names,
			optionNames,
			modifierLines: readRestaurantModifierLines(row.lines),
		})
	}

	const posConditions: SQL[] = [
		inArray(posOrders.status, [...POS_SALE_STATUSES]),
		sql`${posOrders.rungUpAt} <= ${range.end}`,
		...locationFilter(posOrders.locationId, ctx.locationIds),
	]
	if (range.start) {
		posConditions.push(sql`${posOrders.rungUpAt} >= ${range.start}`)
	}
	const posRows = await ctx.db
		.select({
			rungUpAt: posOrders.rungUpAt,
			locationId: posOrders.locationId,
			orderSource: posOrders.orderSource,
			currency: posOrders.currency,
			lines: posOrders.lines,
		})
		.from(posOrders)
		.where(and(...posConditions))
		.orderBy(desc(posOrders.rungUpAt))
		.limit(MENU_INSIGHTS_MAX_ROWS + 1)

	if (posRows.length > MENU_INSIGHTS_MAX_ROWS) truncated = true
	for (const row of posRows.length > MENU_INSIGHTS_MAX_ROWS
		? posRows.slice(0, MENU_INSIGHTS_MAX_ROWS)
		: posRows) {
		if (!row.rungUpAt) continue
		const { sold, lines: modLines, names } = readPosModifierLines(row.lines)
		if (sold.length === 0) continue
		const optionNames = new Map<string, string>()
		for (const line of modLines) {
			for (const option of line.options) {
				optionNames.set(option.optionId, option.name)
			}
		}
		sales.push({
			occurredAt: row.rungUpAt,
			locationId: row.locationId,
			channel: posSalesChannel(row.orderSource),
			currency: row.currency.toUpperCase(),
			lines: sold,
			names: names ?? new Map(),
			optionNames,
			modifierLines: modLines,
		})
	}

	return { sales, truncated }
}

export async function loadItemPairRecords(
	ctx: SalesReportContext,
	subject: ReportSubject,
	definition: ReportDefinition,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const fields = referencedFieldIds(subject, definition)
	const { sales, truncated } = await loadSales(ctx, definition)
	const ordersWithPairs = sales.filter(
		(sale) => distinctItemIds(sale.lines).length >= 2,
	).length
	const records: ReportRecord[] = []

	for (const sale of sales) {
		const ids = distinctItemIds(sale.lines)
		if (ids.length < 2) continue
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) {
				const itemAId = ids[i]!
				const itemBId = ids[j]!
				const record: ReportRecord = {
					occurredAt: sale.occurredAt,
					locationId: sale.locationId,
					channel: sale.channel,
					itemAId,
					itemBId,
					pairIncluded: 1,
					ordersWithPairs,
				}
				if (fields.has('itemAName'))
					record.itemAName = sale.names.get(itemAId) ?? itemAId
				if (fields.has('itemBName'))
					record.itemBName = sale.names.get(itemBId) ?? itemBId
				if (!fields.has('itemAName') && !fields.has('itemBName')) {
					// default list uses names
					record.itemAName = sale.names.get(itemAId) ?? itemAId
					record.itemBName = sale.names.get(itemBId) ?? itemBId
				}
				records.push(record)
			}
		}
	}
	return { records, truncated }
}

export async function loadModifierSalesRecords(
	ctx: SalesReportContext,
	subject: ReportSubject,
	definition: ReportDefinition,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const fields = referencedFieldIds(subject, definition)
	const { sales, truncated } = await loadSales(ctx, definition)
	const attachInput = sales.map((sale) => ({
		lines: sale.modifierLines.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			options: line.options.map((option) => ({
				optionId: option.optionId,
				quantity: option.quantity,
				salesMinor: option.salesMinor,
			})),
		})),
	}))
	const aggregated = computeModifierAttach(attachInput)
	const occurredAt =
		resolveTimeframeRange(
			definition.timeframe.preset,
			ctx.now,
			definition.timeframe,
		).start ?? ctx.now
	const records: ReportRecord[] = aggregated.map((row) => {
		const parentName =
			sales
				.flatMap((sale) => [...sale.names.entries()])
				.find(([id]) => id === row.parentItemId)?.[1] ?? row.parentItemId
		const optionName =
			sales
				.flatMap((sale) => [...sale.optionNames.entries()])
				.find(([id]) => id === row.optionId)?.[1] ?? row.optionId
		const record: ReportRecord = {
			occurredAt,
			locationId: '',
			channel: '',
			parentItemId: row.parentItemId,
			optionId: row.optionId,
			attachCount: row.attachCount,
			parentItemCount: row.parentItemCount,
			sales: row.salesMinor / 100,
			currency: sales[0]?.currency ?? 'USD',
		}
		if (fields.has('parentItemName')) record.parentItemName = parentName
		if (fields.has('optionName')) record.optionName = optionName
		return record
	})
	return { records, truncated }
}
