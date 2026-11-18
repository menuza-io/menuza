import { SALES_BASIS_VALUES } from '@repo/common/sales-report-facts'
import { type Context, Hono } from 'hono'
import { and, desc, eq, gte, isNotNull, lt, lte, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { isValidTimeZone } from '@repo/zoned-time'
import {
	getTenantDb,
	customers,
	shopOrders,
	TENANT_ORG_ID_PATTERN,
	type TenantDatabase,
	voiceCalls,
} from '@repo/tenant-db'
import {
	getField,
	getSubject,
	isReportRunError,
	type ReportDefinition,
	reportDefinitionSchema,
	timeframePresetSchema,
	definitionForLoading,
	referencedFieldIds,
	resolveReportTimeZone,
	timeframeLoadWindow,
	runReport,
	type ReportRecord,
} from '@repo/reports'
import {
	isReservationsReportSubject,
	isStaffingReportSubject,
	operatorTokenAllowsSubject,
	STAFF_PAY_REPORT_PERMISSION,
	verifyOperatorAnalyticsToken,
} from '@repo/reports/token'
import { activeReportCatalog } from '../restaurant/staffing-report-catalog.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { describeStaffError } from '../services/staff-audit.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, getOperatorAnalyticsToken } from '../lib/secrets.ts'
import {
	loadCustomerRecords,
	loadOrderItemRecords,
	loadOrderOptionRecords,
	loadOrderRecords,
	loadTextSubscriberRecords,
	ORDER_REPORT_MAX_ROWS,
} from '../services/report-records.ts'
import {
	auditRsvReportRun,
	loadBookingRecords,
	loadPacingSlotRecords,
	loadWaitlistRecords,
	type RsvReportContext,
} from '../services/rsv-report-records.ts'
import {
	auditStaffReportRun,
	loadApplicationRecords,
	loadLaborDailyRecords,
	loadShiftRecords,
	loadTimeEntryRecords,
	staffAuthFromSubjects,
	type StaffReportContext,
} from '../services/staffing-report-records.ts'
import {
	GIFT_CARD_REPORT_MAX_ROWS,
	loadGiftCardReportRecords,
} from '../services/gift-card-report-records.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import {
	isGiftCardReportSubject,
	type GiftCardReportSubject,
} from '@repo/reports/token'
import {
	loadTodayTotals,
	TODAY_MAX_LOCATIONS,
} from '../services/today-totals.ts'
import {
	loadCashDrawerMovementRecords,
	loadCashDrawerShiftRecords,
} from '../services/cash-drawer-report-records.ts'
import {
	loadCancelledOrderRecords,
	loadOrderRefundRecords,
	loadSalesRecords,
	SALES_REPORT_MAX_ROWS,
	type SalesReportContext,
} from '../services/sales-report-records.ts'
import { isMenuInsightsReportSubject } from '@repo/reports/catalog-menu-insights'
import {
	isSalesReportSubject,
	SALES_STAFF_FIELD_PERMISSION,
} from '@repo/reports/token'
import {
	loadItemPairRecords,
	loadModifierSalesRecords,
	MENU_INSIGHTS_MAX_ROWS,
} from '../services/menu-insights-records.ts'
import { loadSoldOutHistoryRecords } from '../services/sold-out-report-records.ts'
import { loadFinancialPeriodSummary } from '../services/financial-summary-records.ts'
import { loadLocationScorecard } from '../services/location-scorecard-records.ts'

export const analyticsRoutes = new Hono()

const querySchema = z.object({
	definition: reportDefinitionSchema,
	/** The viewer's IANA zone, used when the report follows the user's zone. */
	timeZone: z.string().max(64).optional(),
})

const TENANT_ANALYTICS_SUBJECTS = new Set([
	'orders',
	'order_items',
	'order_options',
	'customers',
	'text_subscribers',
	'shop_orders',
	'phone_calls',
	'time_entries',
	'shifts',
	'labor_daily',
	'applications',
	'bookings',
	'waitlist_entries',
	'pacing_slots',
	'gift_card_sales',
	'gift_card_redemptions',
	'gift_card_balances',
	'gift_card_settlement',
	'sales',
	'order_refunds',
	'cancelled_orders',
	'cash_drawer_shifts',
	'cash_drawer_movements',
	'item_pairs',
	'modifier_sales',
	'sold_out_history',
])

const REPEAT_CALLER_WINDOW_MS = 30 * 86_400_000

/**
 * Most recent calls a phone report reads. Far above a busy business's volume for
 * any preset; it only bounds memory when a report spans a huge call log.
 */
export const PHONE_CALL_REPORT_MAX_ROWS = 50_000

export type PhoneCallReportRow = {
	startedAt: Date
	callerPhone: string | null
	channel: string
	purpose: string | null
	outcome: string | null
	transferResult: string
	calledWhileOpen: boolean | null
	durationSeconds: number | null
	linkSent: boolean
	followUpStatus: string
	rating: number | null
	sentiment: string | null
}

function durationBucket(seconds: number | null) {
	if (seconds == null || seconds < 60) return 'under_1'
	if (seconds < 180) return '1_to_3'
	if (seconds < 300) return '3_to_5'
	return 'over_5'
}

export type PriorPhoneCall = Pick<
	PhoneCallReportRow,
	'startedAt' | 'callerPhone'
>

/**
 * Maps voice_calls rows to the `phone_calls` report fields. Rows may come in
 * any order; repeat callers are found against all rows passed in plus
 * `priorCalls`, the calls from before the report window.
 */
export function mapPhoneCalls(
	rows: readonly PhoneCallReportRow[],
	priorCalls: readonly PriorPhoneCall[] = [],
) {
	const callsByPhone = new Map<string, number[]>()
	for (const row of [...rows, ...priorCalls]) {
		if (!row.callerPhone) continue
		const times = callsByPhone.get(row.callerPhone) ?? []
		times.push(row.startedAt.getTime())
		callsByPhone.set(row.callerPhone, times)
	}
	return rows.map((row): ReportRecord => {
		const startedAt = row.startedAt.getTime()
		const repeatCaller = row.callerPhone
			? (callsByPhone.get(row.callerPhone) ?? []).some(
					(at) => at < startedAt && at >= startedAt - REPEAT_CALLER_WINDOW_MS,
				)
			: false
		return {
			startedAt: row.startedAt,
			callerPhone: row.callerPhone ?? '',
			channel: row.channel,
			purpose: row.purpose ?? 'unknown',
			outcome: row.outcome ?? 'unknown',
			resolvedByAssistant:
				(row.outcome === 'resolved' || row.outcome === 'link_sent') &&
				row.transferResult === 'none',
			transferResult: row.transferResult,
			calledWhileOpen: Boolean(row.calledWhileOpen),
			durationBucket: durationBucket(row.durationSeconds),
			linkSent: Boolean(row.linkSent),
			repeatCaller,
			followUpStatus: row.followUpStatus,
			rating:
				row.rating != null && row.rating >= 1 && row.rating <= 5
					? String(row.rating)
					: 'none',
			sentiment: row.sentiment ?? 'unknown',
		}
	})
}

/**
 * Loads only the calls the report can match: the definition's timeframe goes
 * into the WHERE clause and at most PHONE_CALL_REPORT_MAX_ROWS of the most
 * recent ones are read. Repeat-caller detection also needs the 30 days before
 * the oldest loaded call, read with just the two columns it uses.
 */
export async function loadPhoneCallRecords(
	db: TenantDatabase,
	definition: ReportDefinition,
	now: Date,
	maxRows = PHONE_CALL_REPORT_MAX_ROWS,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	// Only startedAt is a phone_calls timeframe field; anything else fails
	// validation in runReport, so there is nothing to narrow.
	const range =
		definition.timeframe.field === 'startedAt'
			? timeframeLoadWindow(
					definition.timeframe.preset,
					now,
					definition.timeframe,
				)
			: { start: null, end: null }
	const window: SQL[] = []
	if (range.start) window.push(gte(voiceCalls.startedAt, range.start))
	if (range.end) window.push(lte(voiceCalls.startedAt, range.end))

	const loaded = await db
		.select({
			startedAt: voiceCalls.startedAt,
			callerPhone: voiceCalls.callerPhone,
			channel: voiceCalls.channel,
			purpose: voiceCalls.purpose,
			outcome: voiceCalls.outcome,
			transferResult: voiceCalls.transferResult,
			calledWhileOpen: voiceCalls.calledWhileOpen,
			durationSeconds: voiceCalls.durationSeconds,
			linkSent: voiceCalls.linkSent,
			followUpStatus: voiceCalls.followUpStatus,
			rating: voiceCalls.rating,
			sentiment: voiceCalls.sentiment,
		})
		.from(voiceCalls)
		.where(window.length ? and(...window) : undefined)
		.orderBy(desc(voiceCalls.startedAt))
		.limit(maxRows + 1)
	const truncated = loaded.length > maxRows
	const rows = truncated ? loaded.slice(0, maxRows) : loaded

	// When truncated, calls in the window older than the cut still count as
	// earlier calls; they are read here with the rest of the lookback.
	const lookbackEnd = truncated ? rows.at(-1)!.startedAt : range.start
	const priorCalls = lookbackEnd
		? await db
				.select({
					startedAt: voiceCalls.startedAt,
					callerPhone: voiceCalls.callerPhone,
				})
				.from(voiceCalls)
				.where(
					and(
						isNotNull(voiceCalls.callerPhone),
						lt(voiceCalls.startedAt, lookbackEnd),
						gte(
							voiceCalls.startedAt,
							new Date(lookbackEnd.getTime() - REPEAT_CALLER_WINDOW_MS),
						),
					),
				)
				.orderBy(desc(voiceCalls.startedAt))
				.limit(maxRows)
		: []
	return { records: mapPhoneCalls(rows, priorCalls), truncated }
}

function mapShopOrder(row: {
	createdAt: Date | null
	status: string
	productName: string
	amountCents: number
	orgPayoutCents: number
	currency: string
	customerName: string | null
	customerPhone: string | null
	customerEmail: string | null
}): ReportRecord {
	return {
		createdAt: row.createdAt,
		status: row.status,
		productName: row.productName,
		amount: row.amountCents / 100,
		orgPayout: row.orgPayoutCents / 100,
		currency: row.currency || 'usd',
		customerName: row.customerName ?? '',
		customerPhone: row.customerPhone ?? '',
		customerEmail: row.customerEmail ?? '',
	}
}

analyticsRoutes.post('/query', async (c) => {
	const token = getBearerToken(c.req.header('Authorization'))
	if (!token) {
		return c.json(
			{ error: 'unauthorized', message: 'Missing bearer token' },
			401,
		)
	}

	const claims = await verifyOperatorAnalyticsToken({
		signingSecret: getOperatorAnalyticsToken(),
		token,
	})
	if (!claims) {
		return c.json(
			{ error: 'unauthorized', message: 'Invalid operator token' },
			401,
		)
	}

	if (!TENANT_ORG_ID_PATTERN.test(claims.orgId)) {
		return c.json(
			{ error: 'unauthorized', message: 'Invalid organization' },
			401,
		)
	}

	const body = await c.req.json().catch(() => null)
	const parsed = querySchema.safeParse(body)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_definition',
				message: parsed.error.issues[0]?.message || 'Invalid report definition',
			},
			400,
		)
	}

	const { definition } = parsed.data
	if (!TENANT_ANALYTICS_SUBJECTS.has(definition.subject)) {
		return c.json(
			{
				error: 'unknown_subject',
				message: 'This regional API does not support that report subject.',
			},
			400,
		)
	}
	if (!operatorTokenAllowsSubject(claims, definition.subject)) {
		return c.json(
			{
				error: 'forbidden_subject',
				message: 'You do not have permission to report on this data.',
			},
			403,
		)
	}
	const subject = getSubject(activeReportCatalog(), definition.subject)!
	for (const fieldId of referencedFieldIds(subject, definition)) {
		const requires = getField(subject, fieldId)?.requiresSubject
		if (requires && !operatorTokenAllowsSubject(claims, requires)) {
			return c.json(
				{
					error: 'forbidden_subject',
					message:
						requires === STAFF_PAY_REPORT_PERMISSION
							? 'You do not have permission to report on pay data.'
							: requires === 'orders' ||
								  requires === 'order_items' ||
								  requires === 'order_options'
								? 'You do not have permission to report on order data.'
								: 'You do not have permission to report on this data.',
				},
				403,
			)
		}
	}

	const organization = await findActiveOrganizationById(claims.orgId)
	if (!organization) {
		return c.json(
			{ error: 'unauthorized', message: 'Organization not found' },
			401,
		)
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return c.json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${getNodeRegion()}")`,
			},
			409,
		)
	}
	if (!organization.hasProvisionedDb) {
		return c.json(
			{
				error: 'tenant_not_provisioned',
				message: 'This organization has not provisioned a customer database.',
			},
			409,
		)
	}

	if (
		definition.subject === 'shop_orders' &&
		(organization.dataRegion || 'us') !== 'us'
	) {
		return c.json(
			{
				error: 'shop_not_available',
				message: 'Shop order reports are only available for US organizations.',
			},
			403,
		)
	}

	let db
	try {
		db = await getTenantDb(claims.orgId)
	} catch {
		return c.json(
			{
				error: 'tenant_not_provisioned',
				message: 'This organization has not provisioned a customer database.',
			},
			409,
		)
	}

	const now = new Date()
	const timeZone = resolveReportTimeZone(
		definition.settings.timezone,
		parsed.data.timeZone,
	)
	// Loaders read one absolute window that covers the report's range and,
	// when it compares periods, the earlier one too; the engine cuts both.
	const loading = definitionForLoading(definition, now)
	let records: ReportRecord[]
	let sourceTruncated = false
	let sourceRowLimit = 0
	if (isStaffingReportSubject(definition.subject)) {
		const staffCtx: StaffReportContext = {
			db,
			auth: staffAuthFromSubjects({
				orgId: claims.orgId,
				userId: claims.userId,
				subjects: claims.subjects,
				scopeIds: claims.scopeIds,
			}),
			now: now.getTime(),
		}
		let loaded
		try {
			loaded =
				definition.subject === 'time_entries'
					? await loadTimeEntryRecords(staffCtx, loading)
					: definition.subject === 'shifts'
						? await loadShiftRecords(staffCtx, loading)
						: definition.subject === 'labor_daily'
							? await loadLaborDailyRecords(staffCtx, subject, loading)
							: await loadApplicationRecords(staffCtx, loading)
			await auditStaffReportRun(staffCtx, {
				subject: definition.subject,
				rows: loaded.records.length,
				readsPay: claims.subjects.includes(STAFF_PAY_REPORT_PERMISSION),
			})
		} catch (error) {
			// A Drizzle error message quotes every bound value, which for staff
			// data means names and wages: never log or return it.
			console.error('Staff report failed', describeStaffError(error))
			return c.json(
				{ error: 'report_failed', message: 'The report could not be run.' },
				500,
			)
		}
		records = loaded.records
		sourceTruncated = loaded.truncated
		sourceRowLimit = records.length
	} else if (isReservationsReportSubject(definition.subject)) {
		const rsvCtx: RsvReportContext = {
			db,
			orgId: claims.orgId,
			userId: claims.userId,
			locationIds: claims.scopeIds,
			now: now.getTime(),
		}
		let loaded
		try {
			loaded =
				definition.subject === 'bookings'
					? await loadBookingRecords(rsvCtx, loading)
					: definition.subject === 'pacing_slots'
						? await loadPacingSlotRecords(rsvCtx, loading)
						: await loadWaitlistRecords(rsvCtx, loading)
			await auditRsvReportRun(rsvCtx, {
				subject: definition.subject,
				rows: loaded.records.length,
			})
		} catch (error) {
			// A Drizzle error message quotes every bound value: never log it.
			console.error('Reservations report failed', describeStaffError(error))
			return c.json(
				{ error: 'report_failed', message: 'The report could not be run.' },
				500,
			)
		}
		records = loaded.records
		sourceTruncated = loaded.truncated
		sourceRowLimit = records.length
	} else if (isGiftCardReportSubject(definition.subject)) {
		// Money facts only; limited to the token's locations. A report run on a
		// kill-switched node still works: it reads, it never sells.
		let loaded
		try {
			const names = new Map<string, string>()
			try {
				const context = await getReservationsContext(claims.orgId)
				for (const location of context?.locations ?? [])
					names.set(location.id, location.name)
			} catch {
				// Names are a courtesy: the id stands in.
			}
			loaded = await loadGiftCardReportRecords(
				{
					db,
					locationIds: claims.scopeIds,
					now: now.getTime(),
					timeZone,
					locationNames: names,
				},
				definition.subject as GiftCardReportSubject,
			)
		} catch (error) {
			console.error('Gift card report failed', describeStaffError(error))
			return c.json(
				{ error: 'report_failed', message: 'The report could not be run.' },
				500,
			)
		}
		records = loaded.records
		sourceTruncated = loaded.truncated
		sourceRowLimit = GIFT_CARD_REPORT_MAX_ROWS
	} else if (isSalesReportSubject(definition.subject)) {
		// Sales, refunds and cancelled orders from every channel, limited to
		// the token's locations.
		const salesCtx: SalesReportContext = {
			db,
			orgId: claims.orgId,
			locationIds: claims.locationIds,
			now,
		}
		const cashCtx = {
			...salesCtx,
			includeStaffNames: operatorTokenAllowsSubject(
				claims,
				SALES_STAFF_FIELD_PERMISSION,
			),
		}
		let loaded
		try {
			loaded =
				definition.subject === 'sales'
					? await loadSalesRecords(salesCtx, subject, loading)
					: definition.subject === 'order_refunds'
						? await loadOrderRefundRecords(salesCtx, loading)
						: definition.subject === 'cancelled_orders'
							? await loadCancelledOrderRecords(salesCtx, subject, loading)
							: definition.subject === 'cash_drawer_shifts'
								? await loadCashDrawerShiftRecords(cashCtx, loading)
								: await loadCashDrawerMovementRecords(cashCtx, loading)
		} catch (error) {
			// A Drizzle error message quotes every bound value: never log it.
			console.error('Sales report failed', describeStaffError(error))
			return c.json(
				{ error: 'report_failed', message: 'The report could not be run.' },
				500,
			)
		}
		records = loaded.records
		sourceTruncated = loaded.truncated
		sourceRowLimit = SALES_REPORT_MAX_ROWS
	} else if (definition.subject === 'customers') {
		records = await loadCustomerRecords(db, claims.orgId, subject, loading)
	} else if (definition.subject === 'text_subscribers') {
		records = await loadTextSubscriberRecords(db)
	} else if (isMenuInsightsReportSubject(definition.subject)) {
		const salesCtx: SalesReportContext = {
			db,
			orgId: claims.orgId,
			locationIds: claims.locationIds,
			now,
		}
		const loaded =
			definition.subject === 'item_pairs'
				? await loadItemPairRecords(salesCtx, subject, loading)
				: definition.subject === 'modifier_sales'
					? await loadModifierSalesRecords(salesCtx, subject, loading)
					: definition.subject === 'sold_out_history'
						? await loadSoldOutHistoryRecords(
								salesCtx,
								subject,
								loading,
								referencedFieldIds(subject, loading).has('lostSalesEstimate'),
							)
						: { records: [] as ReportRecord[], truncated: false }
		records = loaded.records
		sourceTruncated = loaded.truncated
		sourceRowLimit = MENU_INSIGHTS_MAX_ROWS
	} else if (
		definition.subject === 'orders' ||
		definition.subject === 'order_items' ||
		definition.subject === 'order_options'
	) {
		const loaded =
			definition.subject === 'orders'
				? await loadOrderRecords(db, claims.orgId, subject, loading, now)
				: definition.subject === 'order_items'
					? await loadOrderItemRecords(db, claims.orgId, loading, now)
					: await loadOrderOptionRecords(db, claims.orgId, loading, now)
		records = loaded.records
		sourceTruncated = loaded.truncated
		sourceRowLimit = ORDER_REPORT_MAX_ROWS
	} else if (definition.subject === 'phone_calls') {
		const loaded = await loadPhoneCallRecords(db, loading, now)
		records = loaded.records
		sourceTruncated = loaded.truncated
		sourceRowLimit = PHONE_CALL_REPORT_MAX_ROWS
	} else {
		const rows = await db
			.select({
				createdAt: shopOrders.createdAt,
				status: shopOrders.status,
				productName: shopOrders.productName,
				amountCents: shopOrders.amountCents,
				orgPayoutCents: shopOrders.orgPayoutCents,
				currency: shopOrders.currency,
				customerName: customers.name,
				customerPhone: customers.phone,
				customerEmail: customers.email,
			})
			.from(shopOrders)
			.leftJoin(customers, eq(shopOrders.customerId, customers.id))
		records = rows.map(mapShopOrder)
	}

	const result = runReport(activeReportCatalog(), definition, records, now, {
		timeZone,
	})
	if (isReportRunError(result)) {
		const status = result.error === 'missing_group_by' ? 422 : 400
		return c.json(result, status)
	}

	// `truncated` is the list view's row cap; this says the counts themselves
	// only cover the most recent `sourceRowLimit` calls, orders or rows.
	return c.json(
		sourceTruncated
			? { ...result, sourceTruncated: true, sourceRowLimit }
			: result,
	)
})

const todayQuerySchema = z.object({
	locationIds: z
		.string()
		.max(4000)
		.transform((value) => value.split(',').filter(Boolean))
		.pipe(
			z
				.array(z.string().regex(/^[\w-]{1,64}$/))
				.min(1)
				.max(TODAY_MAX_LOCATIONS),
		),
	timeZones: z
		.string()
		.max(4000)
		.transform((value) => value.split(',').filter(Boolean))
		.pipe(
			z
				.array(
					z
						.string()
						.max(64)
						.refine((zone) => isValidTimeZone(zone)),
				)
				.min(1)
				.max(TODAY_MAX_LOCATIONS),
		),
	salesBasis: z.enum(SALES_BASIS_VALUES).default('net'),
})

/**
 * Today's totals for the home page's Today block: sales and orders per
 * currency for today, yesterday to this time and the same weekday last week,
 * plus distinct guests split first-time and returning. Each location counts
 * its own business day (`timeZones[i]` is the zone of `locationIds[i]`). Same
 * token and order grant as the order reports; totals only, never a record.
 */
analyticsRoutes.get('/today', async (c) => {
	const token = getBearerToken(c.req.header('Authorization'))
	if (!token) {
		return c.json(
			{ error: 'unauthorized', message: 'Missing bearer token' },
			401,
		)
	}
	const claims = await verifyOperatorAnalyticsToken({
		signingSecret: getOperatorAnalyticsToken(),
		token,
	})
	if (!claims || !TENANT_ORG_ID_PATTERN.test(claims.orgId)) {
		return c.json(
			{ error: 'unauthorized', message: 'Invalid operator token' },
			401,
		)
	}
	if (!operatorTokenAllowsSubject(claims, 'orders')) {
		return c.json(
			{
				error: 'forbidden_subject',
				message: 'You do not have permission to report on order data.',
			},
			403,
		)
	}
	const parsed = todayQuerySchema.safeParse({
		locationIds: c.req.query('locationIds') ?? '',
		timeZones: c.req.query('timeZones') ?? '',
		salesBasis: c.req.query('salesBasis') ?? 'net',
	})
	if (
		!parsed.success ||
		parsed.data.locationIds.length !== parsed.data.timeZones.length
	) {
		return c.json(
			{
				error: 'invalid_request',
				message: 'Send matching locationIds and timeZones lists.',
			},
			400,
		)
	}

	const organization = await findActiveOrganizationById(claims.orgId)
	if (!organization) {
		return c.json(
			{ error: 'unauthorized', message: 'Organization not found' },
			401,
		)
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return c.json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${getNodeRegion()}")`,
			},
			409,
		)
	}
	let db
	try {
		if (!organization.hasProvisionedDb) throw new Error('not provisioned')
		db = await getTenantDb(claims.orgId)
	} catch {
		return c.json(
			{
				error: 'tenant_not_provisioned',
				message: 'This organization has not provisioned a customer database.',
			},
			409,
		)
	}

	const { locationIds, timeZones } = parsed.data
	const locations = [
		...new Map(
			locationIds.map((id, index) => [id, { id, timeZone: timeZones[index]! }]),
		).values(),
	]
	const now = Date.now()
	const totals = await loadTodayTotals(
		db,
		claims.orgId,
		locations,
		now,
		parsed.data.salesBasis,
	)
	return c.json({
		...totals,
		asOf: new Date(now).toISOString(),
		salesBasis: parsed.data.salesBasis,
	})
})

const summaryPresetSchema = z.object({
	preset: timeframePresetSchema.default('last_30_days'),
	salesBasis: z.enum(SALES_BASIS_VALUES).default('net'),
})

async function requireSalesAnalytics(c: Context) {
	const token = getBearerToken(c.req.header('Authorization'))
	if (!token) {
		return {
			error: c.json(
				{ error: 'unauthorized', message: 'Missing bearer token' },
				401,
			),
		}
	}
	const claims = await verifyOperatorAnalyticsToken({
		signingSecret: getOperatorAnalyticsToken(),
		token,
	})
	if (!claims || !TENANT_ORG_ID_PATTERN.test(claims.orgId)) {
		return {
			error: c.json(
				{ error: 'unauthorized', message: 'Invalid operator token' },
				401,
			),
		}
	}
	if (!operatorTokenAllowsSubject(claims, 'orders')) {
		return {
			error: c.json(
				{
					error: 'forbidden_subject',
					message: 'You do not have permission to report on order data.',
				},
				403,
			),
		}
	}
	const organization = await findActiveOrganizationById(claims.orgId)
	if (!organization) {
		return {
			error: c.json(
				{ error: 'unauthorized', message: 'Organization not found' },
				401,
			),
		}
	}
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return {
			error: c.json(
				{
					error: 'region_mismatch',
					message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${getNodeRegion()}")`,
				},
				409,
			),
		}
	}
	let db: TenantDatabase
	try {
		if (!organization.hasProvisionedDb) throw new Error('not provisioned')
		db = await getTenantDb(claims.orgId)
	} catch {
		return {
			error: c.json(
				{
					error: 'tenant_not_provisioned',
					message: 'This organization has not provisioned a customer database.',
				},
				409,
			),
		}
	}
	return { claims, db, now: new Date() }
}

analyticsRoutes.get('/financial-summary', async (c) => {
	const auth = await requireSalesAnalytics(c)
	if ('error' in auth) return auth.error
	const parsed = summaryPresetSchema.safeParse({
		preset: c.req.query('preset'),
		salesBasis: c.req.query('salesBasis'),
	})
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: 'Invalid timeframe or sales basis.',
			},
			400,
		)
	}
	const summary = await loadFinancialPeriodSummary(
		{
			db: auth.db,
			orgId: auth.claims.orgId,
			locationIds: auth.claims.locationIds,
			now: auth.now,
		},
		parsed.data.preset,
		parsed.data.salesBasis,
	)
	return c.json({ summary, salesBasis: parsed.data.salesBasis })
})

analyticsRoutes.get('/location-scorecard', async (c) => {
	const auth = await requireSalesAnalytics(c)
	if ('error' in auth) return auth.error
	const parsed = summaryPresetSchema.safeParse({
		preset: c.req.query('preset'),
		salesBasis: c.req.query('salesBasis'),
	})
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: 'Invalid timeframe or sales basis.',
			},
			400,
		)
	}
	const rows = await loadLocationScorecard(
		{
			db: auth.db,
			orgId: auth.claims.orgId,
			locationIds: auth.claims.locationIds,
			now: auth.now,
		},
		parsed.data.preset,
		parsed.data.salesBasis,
	)
	return c.json({ rows, salesBasis: parsed.data.salesBasis })
})

analyticsRoutes.get('/month-sales', async (c) => {
	const auth = await requireSalesAnalytics(c)
	if ('error' in auth) return auth.error
	const parsed = z
		.object({ salesBasis: z.enum(SALES_BASIS_VALUES).default('net') })
		.safeParse({ salesBasis: c.req.query('salesBasis') })
	if (!parsed.success) {
		return c.json(
			{ error: 'invalid_request', message: 'Invalid sales basis.' },
			400,
		)
	}
	const { loadMonthToDateSalesByLocation } =
		await import('../services/location-scorecard-records.ts')
	const byLocation = await loadMonthToDateSalesByLocation(
		{
			db: auth.db,
			orgId: auth.claims.orgId,
			locationIds: auth.claims.locationIds,
			now: auth.now,
		},
		parsed.data.salesBasis,
	)
	return c.json({
		byLocation: Object.fromEntries(byLocation),
		salesBasis: parsed.data.salesBasis,
	})
})
