import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	addDays,
	LABOR_MAX_RANGE_DAYS,
	parseSalesAmount,
	type SalesSource,
	SALES_SOURCES,
} from '@repo/staffing'
import { type LaborMoneyRow } from './labor-types.ts'

/**
 * Pure helpers of the Labor screen: what the address bar holds, the date range
 * it asks for, how a share and an amount read, and the wording of each sales
 * source. No React and no network, so each is covered by unit tests.
 */

export const LABOR_VIEWS = ['overview', 'sales', 'tips', 'settings'] as const
export type LaborViewName = (typeof LABOR_VIEWS)[number]

/** Day counts the range picker offers; every one fits the server's limit. */
export const LABOR_RANGE_DAYS = [7, 14, 30] as const
export type LaborRangeDays = (typeof LABOR_RANGE_DAYS)[number]

export type LaborSearch = {
	view: LaborViewName
	scopeId: string
	/** The last day of the range, `YYYY-MM-DD`. */
	end: string
	days: LaborRangeDays
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function parseLaborSearch(
	params: URLSearchParams,
	today: string,
	defaultScopeId: string,
): LaborSearch {
	const view = params.get('view')
	const days = Number(params.get('days'))
	const end = params.get('end')
	return {
		view: (LABOR_VIEWS as readonly string[]).includes(view ?? '')
			? (view as LaborViewName)
			: 'overview',
		scopeId: params.get('scope') || defaultScopeId,
		// The range never runs past today: there is nothing to add up yet.
		end: end && DATE.test(end) && end <= today ? end : today,
		days: (LABOR_RANGE_DAYS as readonly number[]).includes(days)
			? (days as LaborRangeDays)
			: 7,
	}
}

export function writeLaborSearch(
	current: URLSearchParams,
	patch: Partial<LaborSearch>,
	today: string,
): URLSearchParams {
	const next = new URLSearchParams(current)
	const set = (key: string, value: string | null) => {
		if (value === null || value === '') next.delete(key)
		else next.set(key, value)
	}
	if (patch.view !== undefined) {
		set('view', patch.view === 'overview' ? null : patch.view)
	}
	if (patch.scopeId !== undefined) set('scope', patch.scopeId)
	if (patch.end !== undefined) set('end', patch.end >= today ? null : patch.end)
	if (patch.days !== undefined)
		set('days', patch.days === 7 ? null : String(patch.days))
	return next
}

export function rangeOf(
	end: string,
	days: number,
): { from: string; to: string } {
	const span = Math.min(Math.max(1, days), LABOR_MAX_RANGE_DAYS)
	return { from: addDays(end, -(span - 1)), to: end }
}

/** Moves the range by its own length, never past today. */
export function shiftRange(
	end: string,
	days: number,
	direction: -1 | 1,
	today: string,
): string {
	const next = addDays(end, direction * days)
	return next > today ? today : next
}

// ---------------------------------------------------------------------------
// Sales source wording
// ---------------------------------------------------------------------------

export const SOURCE_NAMES: Record<SalesSource, MessageDescriptor> = {
	online_orders: msg`Online orders only`,
	online_only: msg`Online orders (all sales)`,
	manual: msg`Entered sales`,
}

/** One sentence on what the sales behind a share do and do not include. */
export const SOURCE_NOTES: Record<SalesSource, MessageDescriptor> = {
	online_orders: msg`Only online orders are counted. In-person and other sales are not, so the share is higher than it really is.`,
	online_only: msg`All of this workplace's sales are online orders, so the share can be judged against the target.`,
	manual: msg`The sales your team enters each day. Online orders are not added on top.`,
}

export const SOURCE_CHOICES: ReadonlyArray<{
	value: SalesSource
	title: MessageDescriptor
	description: MessageDescriptor
}> = [
	{
		value: 'online_orders',
		title: msg`Online orders`,
		description: msg`Count paid online orders as sales. The share is shown but never judged against a target, because walk-in sales are missing.`,
	},
	{
		value: 'online_only',
		title: msg`Online orders, and this workplace sells nothing else`,
		description: msg`Count online orders as all sales. The share is judged against your target.`,
	},
	{
		value: 'manual',
		title: msg`Sales I enter`,
		description: msg`Type in each day's sales, or upload a file from your register. The share is judged against your target.`,
	},
]

export function isSalesSource(value: string): value is SalesSource {
	return (SALES_SOURCES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** A share in basis points as a percentage: 2843 reads `28.4%`. */
export function formatShare(bp: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'percent',
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		}).format(bp / 10_000)
	} catch {
		return `${(bp / 100).toFixed(1)}%`
	}
}

/** A whole-percent target: 3000 reads `30%`. */
export function formatTarget(bp: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'percent',
			maximumFractionDigits: 1,
		}).format(bp / 10_000)
	} catch {
		return `${bp / 100}%`
	}
}

/** What goes into an amount box: two decimals, no grouping, a plain dot. */
export function amountInputOf(minor: number): string {
	const whole = Math.floor(minor / 100)
	const cents = String(minor % 100).padStart(2, '0')
	return `${whole}.${cents}`
}

export type AmountInput =
	| { state: 'empty' }
	| { state: 'ok'; minor: number }
	| { state: 'invalid'; code: string }

export function readAmountInput(text: string): AmountInput {
	if (text.trim() === '') return { state: 'empty' }
	const result = parseSalesAmount(text)
	return result.ok
		? { state: 'ok', minor: result.minor }
		: { state: 'invalid', code: result.code }
}

export function moneyIn(
	rows: readonly LaborMoneyRow[],
	currency: string,
): LaborMoneyRow | undefined {
	return rows.find((row) => row.currency === currency)
}

export function currenciesOf(rows: readonly LaborMoneyRow[]): string[] {
	return [...new Set(rows.map((row) => row.currency))].sort()
}

/** Decimal hours to one place, for a column that must stay narrow. */
export function hoursOf(minutes: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		}).format(Math.round((minutes / 60) * 10) / 10)
	} catch {
		return (Math.round((minutes / 60) * 10) / 10).toFixed(1)
	}
}

/** A percentage typed as text (`2.9`) to basis points (290). Null when it is not a number with at most two decimals. */
export function percentToBp(text: string): number | null {
	const trimmed = text.trim().replace(',', '.')
	if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null
	return Math.round(Number(trimmed) * 100)
}

export function bpToPercentText(bp: number): string {
	const value = bp / 100
	return Number.isInteger(value)
		? String(value)
		: value.toFixed(2).replace(/0+$/, '')
}

/** Orders per hour typed as text. Null when empty or not one decimal in range. */
export function readOrdersPerHour(text: string): number | null {
	const trimmed = text.trim().replace(',', '.')
	if (!/^\d{1,3}(\.\d)?$/.test(trimmed)) return null
	const value = Number(trimmed)
	return value >= 0.5 && value <= 200 ? value : null
}

/** Position label in the viewer's language, falling back to the name. */
export function positionLabel(
	position: { name: string; nameAr: string | null },
	locale: string,
): string {
	return locale.startsWith('ar') && position.nameAr
		? position.nameAr
		: position.name
}
