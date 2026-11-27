import {
	and,
	AccountingExport,
	AccountingMapping,
	AccountingSettings,
	db,
	desc,
	eq,
	inArray,
} from '@repo/database'
import {
	ACCOUNTING_LAYOUTS,
	adjustingEntry,
	adjustingLines,
	buildJournalDay,
	entryFromDay,
	journalHash,
	journalToCsv,
	type AccountingDayFacts,
	type AccountingLayout,
	type AccountMapping,
	type JournalEntry,
	type JournalLine,
} from '@repo/reports'
import { localParts } from '@repo/staffing'
import { isAccountingEnabled } from './accounting-flag.ts'

/**
 * The accounting export, App side (#189). The region reports each location's
 * day (totals only); the payment provider's payouts and fees are added here
 * from the same payout data the Payments page reads (#168), so the payout line
 * is the payout report's. The operator maps each journal line to an account
 * once; the files (QuickBooks, Xero, generic) are built here.
 *
 * A day is exported as final only after it closes. Exporting a closed day again
 * never rewrites it: if a late refund or payout changed it, the change goes out
 * as an adjusting entry (`AccountingExport.sequence` 2, 3...); if nothing
 * changed, nothing goes out.
 */

export { mergeAccountingDays, providerDayFacts, PROVIDER_LOCATION_ID, type ProviderPayout } from './accounting-days.ts'

export { ACCOUNTING_FLAG, isAccountingEnabled } from './accounting-flag.ts'

export async function loadAccountMapping(
	organizationId: string,
): Promise<AccountMapping> {
	const rows = await db
		.select()
		.from(AccountingMapping)
		.where(eq(AccountingMapping.organizationId, organizationId))
	return Object.fromEntries(
		rows.map((row) => [
			row.lineKey,
			{ code: row.accountCode, name: row.accountName },
		]),
	)
}

const LINE_KEY = /^[a-z_]+(?::[A-Za-z0-9_-]+)?$/

/** Saves the mapping once: a row with a name is written, one with none is removed. */
export async function saveAccountMapping(
	organizationId: string,
	rows: Array<{ lineKey: string; accountCode: string; accountName: string }>,
) {
	for (const row of rows.slice(0, 200)) {
		if (!LINE_KEY.test(row.lineKey)) continue
		const name = row.accountName.trim().slice(0, 120)
		const code = row.accountCode.trim().slice(0, 40)
		if (name === '') {
			await db
				.delete(AccountingMapping)
				.where(
					and(
						eq(AccountingMapping.organizationId, organizationId),
						eq(AccountingMapping.lineKey, row.lineKey),
					),
				)
			continue
		}
		await db
			.insert(AccountingMapping)
			.values({
				organizationId,
				lineKey: row.lineKey,
				accountCode: code,
				accountName: name,
			})
			.onConflictDoUpdate({
				target: [AccountingMapping.organizationId, AccountingMapping.lineKey],
				set: { accountCode: code, accountName: name, updatedAt: new Date() },
			})
	}
}

export type AccountingSettingsView = {
	layout: AccountingLayout
	bookkeeperEmail: string | null
	weeklyEmail: boolean
}

export async function loadAccountingSettings(
	organizationId: string,
): Promise<AccountingSettingsView> {
	const [row] = await db
		.select()
		.from(AccountingSettings)
		.where(eq(AccountingSettings.organizationId, organizationId))
		.limit(1)
	return {
		layout: (ACCOUNTING_LAYOUTS as readonly string[]).includes(row?.layout ?? '')
			? (row!.layout as AccountingLayout)
			: 'generic',
		bookkeeperEmail: row?.bookkeeperEmail ?? null,
		weeklyEmail: row?.weeklyEmail ?? false,
	}
}

export async function saveAccountingSettings(
	organizationId: string,
	input: AccountingSettingsView,
) {
	await db
		.insert(AccountingSettings)
		.values({
			organizationId,
			layout: input.layout,
			bookkeeperEmail: input.bookkeeperEmail,
			weeklyEmail: input.weeklyEmail,
		})
		.onConflictDoUpdate({
			target: AccountingSettings.organizationId,
			set: {
				layout: input.layout,
				bookkeeperEmail: input.bookkeeperEmail,
				weeklyEmail: input.weeklyEmail,
				updatedAt: new Date(),
			},
		})
}

// ---------------------------------------------------------------------------
// Export: final days once, adjusting entries for a changed day, files built here
// ---------------------------------------------------------------------------

export type PreparedExport = {
	entries: JournalEntry[]
	csv: string
	/** Days already exported and unchanged: nothing goes out for them. */
	unchanged: number
	adjustments: number
	provisional: number
	/** Days whose debits and credits differ (the gap is in the file). */
	outOfBalance: number
}

function parseLines(json: string): JournalLine[] {
	try {
		const parsed = JSON.parse(json) as JournalLine[]
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

export async function prepareAccountingExport(input: {
	organizationId: string
	userId: string | null
	days: readonly AccountingDayFacts[]
	mapping: AccountMapping
	layout: AccountingLayout
	/** Record what was exported (the Export button); a preview records nothing. */
	record: boolean
}): Promise<PreparedExport> {
	const entries: JournalEntry[] = []
	let unchanged = 0
	let adjustments = 0
	let provisional = 0
	let outOfBalance = 0
	const dates = [...new Set(input.days.map((d) => d.businessDate))]
	const previous =
		dates.length === 0
			? []
			: await db
					.select()
					.from(AccountingExport)
					.where(
						and(
							eq(AccountingExport.organizationId, input.organizationId),
							inArray(AccountingExport.businessDate, dates),
						),
					)
					.orderBy(desc(AccountingExport.sequence))
	const latest = new Map<string, (typeof previous)[number]>()
	for (const row of previous) {
		const key = `${row.locationId}|${row.businessDate}|${row.currency}`
		if (!latest.has(key)) latest.set(key, row)
	}
	for (const facts of input.days) {
		const day = buildJournalDay(facts)
		if (day.differenceMinor !== 0) outOfBalance += 1
		if (!facts.closed) {
			// An open day is shown, labelled provisional, and never recorded.
			provisional += 1
			entries.push(entryFromDay(day))
			continue
		}
		const key = `${facts.locationId}|${facts.businessDate}|${facts.currency}`
		const before = latest.get(key)
		const hash = journalHash(day.lines)
		if (!before) {
			entries.push(entryFromDay(day))
			if (input.record) {
				await db.insert(AccountingExport).values({
					organizationId: input.organizationId,
					locationId: facts.locationId,
					businessDate: facts.businessDate,
					currency: facts.currency,
					sequence: 1,
					status: 'final',
					totalsHash: hash,
					lines: JSON.stringify(day.lines),
					exportedById: input.userId,
				})
			}
			continue
		}
		if (before.totalsHash === hash) {
			unchanged += 1
			continue
		}
		const delta = adjustingLines(parseLines(before.lines), day.lines)
		const sequence = before.sequence + 1
		entries.push(adjustingEntry(day, delta, sequence))
		adjustments += 1
		if (input.record) {
			await db.insert(AccountingExport).values({
				organizationId: input.organizationId,
				locationId: facts.locationId,
				businessDate: facts.businessDate,
				currency: facts.currency,
				sequence,
				status: 'adjustment',
				totalsHash: hash,
				// The cumulative state, so the next change is measured against it.
				lines: JSON.stringify(day.lines),
				exportedById: input.userId,
			})
		}
	}
	return {
		entries,
		csv: journalToCsv(entries, input.mapping, input.layout),
		unchanged,
		adjustments,
		provisional,
		outOfBalance,
	}
}

// ---------------------------------------------------------------------------
// Fetching: the region's days, the provider's payouts, and the weekly email
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from 'node:crypto'
import { Organization } from '@repo/database'
import { sendEmail } from '@repo/email'
import { renderTableEmail } from '@repo/reports'
import { accountingDaysSchema, mergeAccountingDays } from './accounting-days.ts'
import { postRegionalReports } from './regional-reports.server.ts'
import { defaultReportingTimeZone } from './schedules.server.ts'
import { localDateKey } from '@repo/reports/schedule'
import { ENV } from 'varlock/env'
import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	getOrganizationPayoutDetail,
	getOrganizationPayoutsSnapshot,
} from '#app/utils/payments/payouts.server.ts'
import { normalizeShopProcessor } from '#app/utils/shop.types.ts'
import { providerDayFacts as toProviderFacts } from './accounting-days.ts'

export type AccountingOrg = {
	id: string
	name: string
	slug: string
	dataRegion: string
	shopPaymentProvider: string | null
	stripeConnectAccountId: string | null
	checkoutSubEntityId: string | null
}

/** The day's figures for a range from the organization's own region: totals only. */
export async function fetchRegionalAccountingDays(input: {
	org: Pick<AccountingOrg, 'id' | 'dataRegion'>
	from: string
	to: string
	locationIds?: string[] | null
	post?: typeof postRegionalReports
}): Promise<AccountingDayFacts[]> {
	const post = input.post ?? postRegionalReports
	const response = await post({
		dataRegion: input.org.dataRegion,
		path: 'accounting',
		body: {
			orgId: input.org.id,
			from: input.from,
			to: input.to,
			locationIds: input.locationIds ?? null,
		},
	})
	if (!response.ok) throw new Error(`region_${response.status}`)
	return accountingDaysSchema.parse(await response.json()).days
}

/**
 * The provider's payouts and the fees taken from them, as the Payments page
 * reads them (`getOrganizationPayoutsSnapshot`), for a range of arrival days.
 */
export async function loadProviderAccountingDays(input: {
	org: AccountingOrg
	from: string
	to: string
	timeZone: string
	now?: Date
}): Promise<AccountingDayFacts[]> {
	const org = input.org
	const isUs = (org.dataRegion || 'us') === 'us'
	const normalized = isUs ? normalizeShopProcessor(org.shopPaymentProvider) : 'checkout'
	const provider: 'connect' | 'checkout' = normalized === 'checkout' ? 'checkout' : 'connect'
	const connectedAccountId =
		provider === 'checkout' ? org.checkoutSubEntityId : org.stripeConnectAccountId
	const { snapshot } = await getOrganizationPayoutsSnapshot({
		organizationId: org.id,
		provider,
		connectedAccountId,
		currency: isUs ? 'USD' : 'SAR',
	})
	const now = input.now ?? new Date()
	const inRange = snapshot.payouts
		.filter((p) => {
			const date = localDateKey(new Date(p.arrivalDate), input.timeZone)
			return date >= input.from && date <= input.to
		})
		.slice(0, 60)
	const payouts = []
	for (const payout of inRange) {
		let feeCents = 0
		try {
			const { detail } = await getOrganizationPayoutDetail({
				organizationId: org.id,
				provider,
				connectedAccountId,
				payoutId: payout.id,
				currency: payout.currency,
			})
			feeCents = detail.transactions.reduce(
				(sum, t) => sum + Math.abs(t.providerFeeCents) + Math.abs(t.platformFeeCents),
				0,
			)
		} catch {
			// Fees are left off a payout whose detail cannot be read; the payout stays.
		}
		payouts.push({
			arrivalDate: payout.arrivalDate,
			currency: payout.currency,
			amountCents: payout.amountCents,
			status: payout.status,
			feeCents,
		})
	}
	return toProviderFacts({
		payouts,
		from: input.from,
		to: input.to,
		timeZone: input.timeZone,
		today: localDateKey(now, input.timeZone),
	})
}

/** A whole journal for a range, as it stands now (no history): the bookkeeper's file. */
export function fullJournalCsv(
	days: readonly AccountingDayFacts[],
	mapping: AccountMapping,
	layout: AccountingLayout,
) {
	return journalToCsv(
		days.map((facts) => entryFromDay(buildJournalDay(facts))),
		mapping,
		layout,
	)
}

// -- the bookkeeper's signed download link (no login) ------------------------

const LINK_PURPOSE = 'accounting-link:v1'
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type AccountingLink = {
	organizationId: string
	from: string
	to: string
	layout: AccountingLayout
}

function linkKey() {
	return createHmac('sha256', String(ENV.SESSION_SECRET ?? '')).update(LINK_PURPOSE).digest()
}

export function signAccountingLink(link: AccountingLink, now = Date.now()) {
	const payload = Buffer.from(
		JSON.stringify({ ...link, exp: now + LINK_TTL_MS }),
	).toString('base64url')
	const mac = createHmac('sha256', linkKey()).update(payload).digest('base64url')
	return `${payload}.${mac}`
}

export function verifyAccountingLink(token: string, now = Date.now()): AccountingLink | null {
	const [payload, mac, extra] = token.split('.')
	if (!payload || !mac || extra !== undefined || token.length > 800) return null
	const expected = createHmac('sha256', linkKey()).update(payload).digest()
	let given: Buffer
	try {
		given = Buffer.from(mac, 'base64url')
	} catch {
		return null
	}
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
	try {
		const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccountingLink & { exp: number }
		if (
			typeof parsed.exp !== 'number' ||
			parsed.exp < now ||
			typeof parsed.organizationId !== 'string' ||
			!/^\d{4}-\d{2}-\d{2}$/.test(parsed.from) ||
			!/^\d{4}-\d{2}-\d{2}$/.test(parsed.to) ||
			!(ACCOUNTING_LAYOUTS as readonly string[]).includes(parsed.layout)
		) {
			return null
		}
		return { organizationId: parsed.organizationId, from: parsed.from, to: parsed.to, layout: parsed.layout }
	} catch {
		return null
	}
}

function money(minor: number, currency: string) {
	try {
		return new Intl.NumberFormat('en', { style: 'currency', currency }).format(minor / 100)
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`
	}
}

export type RunWeeklyDeps = {
	now?: Date
	post?: typeof postRegionalReports
	sendEmailImpl?: typeof sendEmail
	/** Tests inject the provider's days; production reads the payout data. */
	providerDays?: (input: { org: AccountingOrg; from: string; to: string; timeZone: string }) => Promise<AccountingDayFacts[]>
}

/**
 * The optional weekly email to the bookkeeper (#189): on Monday from 07:00
 * (organization reporting time), last week's journal as a table and a signed
 * link to the file. The address is typed in the accounting settings, outside
 * the member list (the one free-text recipient here, because a bookkeeper is
 * rarely a member). It sends once a week and only while the flag is on.
 */
export async function runWeeklyAccountingEmails(deps: RunWeeklyDeps = {}) {
	const now = deps.now ?? new Date()
	const send = deps.sendEmailImpl ?? sendEmail
	const summary = { checked: 0, sent: 0, failed: 0 }
	const settings = await db
		.select()
		.from(AccountingSettings)
		.where(eq(AccountingSettings.weeklyEmail, true))
	for (const row of settings) {
		if (!row.bookkeeperEmail) continue
		if (!(await isAccountingEnabled(row.organizationId))) continue
		const [org] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				dataRegion: Organization.dataRegion,
				shopPaymentProvider: Organization.shopPaymentProvider,
				stripeConnectAccountId: Organization.stripeConnectAccountId,
				checkoutSubEntityId: Organization.checkoutSubEntityId,
				hasProvisionedDb: Organization.hasProvisionedDb,
			})
			.from(Organization)
			.where(eq(Organization.id, row.organizationId))
			.limit(1)
		if (!org || !org.hasProvisionedDb) continue
		const timeZone = await defaultReportingTimeZone(org.id)
		const local = localParts(now.getTime(), timeZone)
		const today = localDateKey(now, timeZone)
		const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
		if (weekday !== 1 || local.hour < 7 || row.lastWeeklyKey === today) continue
		summary.checked += 1
		// Last Monday to Sunday.
		const from = shiftDay(today, -7)
		const to = shiftDay(today, -1)
		try {
			const regional = await fetchRegionalAccountingDays({ org, from, to, post: deps.post })
			const providerDays = deps.providerDays ?? ((input) => loadProviderAccountingDays({ ...input, now }))
			const provider = await providerDays({ org, from, to, timeZone }).catch(() => [])
			const days = mergeAccountingDays(regional, provider)
			const mapping = await loadAccountMapping(org.id)
			const layout = (ACCOUNTING_LAYOUTS as readonly string[]).includes(row.layout)
				? (row.layout as AccountingLayout)
				: 'generic'
			const base = readLiveEnv('BASE_URL').replace(/\/$/u, '')
			const link = `${base}/resources/accounting-export?token=${encodeURIComponent(
				signAccountingLink({ organizationId: org.id, from, to, layout }),
			)}`
			const rows = [
				['Date', 'Location', 'Debits', 'Credits', 'Status'],
				...days.map((facts) => {
					const day = buildJournalDay(facts)
					return [
						day.businessDate,
						day.locationName,
						money(day.debitMinor, day.currency),
						money(day.creditMinor, day.currency),
						day.differenceMinor !== 0
							? `Out of balance by ${money(Math.abs(day.differenceMinor), day.currency)}`
							: day.status === 'final'
								? 'Final'
								: 'Provisional',
					]
				}),
			]
			const rendered = renderTableEmail({
				locale: 'en',
				organizationName: org.name,
				title: 'Weekly sales journal',
				subtitle: `${from} to ${to}`,
				rows,
				maxRows: 40,
				reportUrl: `${base}/${org.slug}/reports/accounting`,
				csvUrl: link,
				unsubscribeUrl: null,
			})
			const sent = await send({
				to: row.bookkeeperEmail,
				subject: rendered.subject,
				html: rendered.html,
				text: rendered.text,
			})
			if (sent.status === 'error') throw new Error('send_failed')
			await db
				.update(AccountingSettings)
				.set({ lastWeeklyKey: today })
				.where(eq(AccountingSettings.organizationId, org.id))
			summary.sent += 1
		} catch {
			summary.failed += 1
		}
	}
	return summary
}

function shiftDay(key: string, days: number) {
	const d = new Date(`${key}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() + days)
	return d.toISOString().slice(0, 10)
}
