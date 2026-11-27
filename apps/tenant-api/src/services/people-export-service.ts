import { minorToMajorText } from '@repo/common/money'
import { EXPORT_CHUNK_ROWS, EXPORT_MAX_ROWS } from '@repo/reports/export'
import {
	formExportAudit,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { sql } from 'drizzle-orm'
import { badRequest } from '../lib/http.ts'
import {
	queryPeople,
	type PeopleAccess,
	type PeopleListInput,
	requireCustomersFacet,
} from './people-service.ts'
import { countedOrderCondition } from './report-records.ts'

/**
 * `GET /operator/people/export` (#231): the Customers list as CSV rows, one
 * chunk per request so the browser can show progress and cancel (#386). It
 * reads the SAME query as the list (`queryPeople`), so the file holds exactly
 * the filtered view, in the same order. Runs in the region; the browser calls
 * it directly, so nothing passes through the US App.
 *
 * - Needs the customers facet (the customer read grant), like the contact
 *   columns it carries.
 * - At most `EXPORT_MAX_ROWS` rows; a cut file says so in its last row.
 * - Erased people are not in the list, so they are never in the file.
 * - Spend has one column per currency the organization sells in; money is
 *   never added across currencies.
 * - One audit row (`form_export_audit`, kind `people`) per export, written
 *   with the first chunk: who and how many rows, never a value.
 */

export const PEOPLE_EXPORT_MAX_ROWS = EXPORT_MAX_ROWS

type ExportCursor = {
	/** The list's keyset cursor of the next page. */
	c: string | null
	/** Rows already sent. */
	n: number
	/** Rows matching the filters (before the cap). */
	m: number
	/** Currencies of the spend columns, fixed by the first chunk. */
	cur: string[]
}

function encode(cursor: ExportCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decode(raw: string): ExportCursor {
	try {
		const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
		if (
			parsed &&
			typeof parsed.n === 'number' &&
			Number.isInteger(parsed.n) &&
			parsed.n >= 0 &&
			typeof parsed.m === 'number' &&
			Array.isArray(parsed.cur) &&
			parsed.cur.every((c: unknown) => typeof c === 'string') &&
			(parsed.c === null || typeof parsed.c === 'string')
		) {
			return parsed as ExportCursor
		}
	} catch {
		// fall through
	}
	throw badRequest('invalid_cursor', 'The export cursor is not valid')
}

export function peopleExportHeader(currencies: readonly string[]): string[] {
	return [
		'Name',
		'Email',
		'Phone',
		'Joined',
		'Last order',
		'Orders',
		...(currencies.length > 0
			? currencies.map((c) => `Total spend (${c})`)
			: ['Total spend']),
		'Email subscription',
		'Text subscription',
		'Points balance',
		'Points used',
	]
}

function isoDate(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
		return ''
	}
	return new Date(ms).toISOString().slice(0, 10)
}

export type PeopleExportChunk = {
	header: string[]
	rows: string[][]
	nextCursor: string | null
	/** Rows the export will hold (after the cap). */
	total: number
	/** Rows matching the filters. */
	matching: number
	truncated: boolean
	footer: string[][] | null
}

async function exportCurrencies(db: TenantDatabase): Promise<string[]> {
	// The same sales rule as the spend CTE: only counted orders have a currency here.
	const rows = await db
		.selectDistinct({ currency: sql<string>`upper(${restaurantOrders.currency})` })
		.from(restaurantOrders)
		.where(countedOrderCondition())
		.orderBy(sql`1`)
	return rows.map((r) => r.currency).filter(Boolean)
}

export async function exportPeopleChunk(
	db: TenantDatabase,
	access: PeopleAccess,
	input: PeopleListInput,
	opts: {
		cursor?: string
		chunkRows?: number
		actorId: string
		maxRows?: number
	},
): Promise<PeopleExportChunk> {
	requireCustomersFacet(access)
	const cap = Math.min(opts.maxRows ?? PEOPLE_EXPORT_MAX_ROWS, PEOPLE_EXPORT_MAX_ROWS)
	const chunkRows = Math.min(
		Math.max(opts.chunkRows ?? EXPORT_CHUNK_ROWS, 1),
		EXPORT_CHUNK_ROWS,
	)
	const state = opts.cursor ? decode(opts.cursor) : null
	const sent = state?.n ?? 0
	const remaining = Math.max(0, cap - sent)
	const limit = Math.min(chunkRows, remaining)
	if (limit === 0) {
		return {
			header: peopleExportHeader(state?.cur ?? []),
			rows: [],
			nextCursor: null,
			total: Math.min(state?.m ?? 0, cap),
			matching: state?.m ?? 0,
			truncated: (state?.m ?? 0) > cap,
			footer: null,
		}
	}

	const currencies = state ? state.cur : await exportCurrencies(db)
	const page = await queryPeople(
		db,
		access,
		{ ...input, cursor: state?.c ?? undefined, limit },
		{ limitCap: EXPORT_CHUNK_ROWS, lean: true },
	)
	const matching = state ? state.m : page.total
	const total = Math.min(matching, cap)
	if (!state) {
		// One audit row per export, with the first chunk: ids and a count, no PII.
		await db.insert(formExportAudit).values({
			kind: 'people',
			targetId: '',
			operatorId: opts.actorId,
			rowCount: total,
		})
	}

	const rows = page.people.map((person) => {
		const spendBy = new Map(
			(person.spend ?? []).map((s) => [s.currency, s.minor] as const),
		)
		const spendCells =
			currencies.length > 0
				? currencies.map((c) =>
						spendBy.has(c) ? minorToMajorText(spendBy.get(c)!, c) : '',
					)
				: ['']
		return [
			person.name,
			person.email ?? '',
			person.phone ?? '',
			isoDate(person.createdAt),
			isoDate(person.orders?.lastOrderAt),
			String(person.orders?.count ?? 0),
			...spendCells,
			person.marketing?.email ? 'Subscribed' : 'No',
			person.marketing?.sms ? 'Subscribed' : 'No',
			String(person.points?.balance ?? 0),
			String(person.points?.used ?? 0),
		]
	})

	const nowSent = sent + rows.length
	const more = page.nextCursor !== null && nowSent < cap
	const truncated = matching > cap
	const nextCursor = more
		? encode({ c: page.nextCursor, n: nowSent, m: matching, cur: currencies })
		: null
	const footer =
		!more && truncated
			? [
					[
						`Export cut at ${cap} rows. Narrow the filters to export all ${matching} matching people.`,
					],
				]
			: null
	return {
		header: peopleExportHeader(currencies),
		rows,
		nextCursor,
		total,
		matching,
		truncated,
		footer,
	}
}
