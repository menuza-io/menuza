import { Hono } from 'hono'
import { and, desc, eq, gte, isNotNull, lt, lte, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
	getTenantDb,
	customers,
	shopOrders,
	TENANT_ORG_ID_PATTERN,
	type TenantDatabase,
	voiceCalls,
} from '@repo/tenant-db'
import {
	isReportRunError,
	organizationCatalog,
	type ReportDefinition,
	reportDefinitionSchema,
	resolveTimeframeRange,
	runReport,
	type ReportRecord,
} from '@repo/reports'
import {
	operatorTokenAllowsSubject,
	verifyOperatorAnalyticsToken,
} from '@repo/reports/token'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, getInternalCommandToken } from '../lib/secrets.ts'

export const analyticsRoutes = new Hono()

const querySchema = z.object({
	definition: reportDefinitionSchema,
})

const TENANT_ANALYTICS_SUBJECTS = new Set([
	'customers',
	'shop_orders',
	'phone_calls',
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
			? resolveTimeframeRange(
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

function formatMoney(cents: number, currency = 'usd') {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: currency.toUpperCase(),
	}).format(cents / 100)
}

function mapCustomer(row: {
	createdAt: Date | null
	phoneVerified: boolean | null
	email: string | null
	name: string | null
	phone: string | null
}): ReportRecord {
	return {
		createdAt: row.createdAt,
		phoneVerified: Boolean(row.phoneVerified),
		hasEmail: Boolean(row.email && row.email.length > 0),
		email: row.email ?? '',
		name: row.name ?? '',
		phone: row.phone ?? '',
	}
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
	const currency = row.currency || 'usd'
	return {
		createdAt: row.createdAt,
		status: row.status,
		productName: row.productName,
		amount: formatMoney(row.amountCents, currency),
		orgPayout: formatMoney(row.orgPayoutCents, currency),
		currency,
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
		internalCommandToken: getInternalCommandToken(),
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
				message: parsed.error.errors[0]?.message || 'Invalid report definition',
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
	let records: ReportRecord[]
	let sourceTruncated = false
	if (definition.subject === 'customers') {
		const rows = await db
			.select({
				createdAt: customers.createdAt,
				phoneVerified: customers.phoneVerified,
				email: customers.email,
				name: customers.name,
				phone: customers.phone,
			})
			.from(customers)
		records = rows.map(mapCustomer)
	} else if (definition.subject === 'phone_calls') {
		const loaded = await loadPhoneCallRecords(db, definition, now)
		records = loaded.records
		sourceTruncated = loaded.truncated
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

	const result = runReport(organizationCatalog, definition, records, now)
	if (isReportRunError(result)) {
		const status = result.error === 'missing_group_by' ? 422 : 400
		return c.json(result, status)
	}

	// `truncated` is the list view's row cap; this says the counts themselves
	// only cover the most recent PHONE_CALL_REPORT_MAX_ROWS calls.
	return c.json(
		sourceTruncated
			? {
					...result,
					sourceTruncated: true,
					sourceRowLimit: PHONE_CALL_REPORT_MAX_ROWS,
				}
			: result,
	)
})
