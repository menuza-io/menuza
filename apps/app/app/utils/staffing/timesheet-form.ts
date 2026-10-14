import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	type BreakKind,
	LOCAL_TIME_PATTERN,
	localTimeToInstant,
	resolveLocalBreakTimes,
	resolveLocalCardTimes,
} from '@repo/staffing'
import { minorToInput, parseMoneyToMinor } from './staff-format.ts'
import { type TimesheetCardRow } from './timesheet-types.ts'
import { calendarDateOf, isValidDate, timeInputOf } from './timesheet-view.ts'

/**
 * The add and edit time card form, without any React: starting values from a
 * card, the checks that save a round trip, and the request body. The server
 * checks every rule again (and is the only judge of overlap with other cards);
 * these exist so the manager is pointed at the field, in plain words.
 *
 * Times are typed as dates and times of day in the SCOPE's time zone (the
 * zone stored on the card), never the browser's: "9:03 AM" only means
 * something where the workplace is. The shared `@repo/staffing` functions turn
 * them into instants the same way the server does.
 */

type Translate = (descriptor: MessageDescriptor) => string

export type BreakForm = {
	/** Stable key for React lists and error lookups. */
	key: string
	kind: BreakKind
	start: string
	end: string
}

export type CardForm = {
	staffId: string
	scopeId: string
	positionId: string
	date: string
	start: string
	end: string
	breaks: BreakForm[]
	cashTips: string
	creditTips: string
	note: string
	reason: string
}

/** The longest card the server accepts. */
export const MAX_CARD_MINUTES = 48 * 60

let breakCounter = 0
export function newBreakKey(): string {
	breakCounter += 1
	return `break-${breakCounter}`
}

export function emptyBreak(kind: BreakKind = 'meal'): BreakForm {
	return { key: newBreakKey(), kind, start: '', end: '' }
}

export function emptyForm(
	input: Partial<Pick<CardForm, 'scopeId' | 'staffId' | 'date'>> = {},
): CardForm {
	return {
		staffId: input.staffId ?? '',
		scopeId: input.scopeId ?? '',
		positionId: '',
		date: input.date ?? '',
		start: '',
		end: '',
		breaks: [],
		cashTips: '',
		creditTips: '',
		note: '',
		reason: '',
	}
}

/** Starting values from a card, in its own time zone. Tips only when money is visible. */
export function cardToForm(card: TimesheetCardRow): CardForm {
	const zone = card.timeZone
	return {
		staffId: card.staffId,
		scopeId: card.scopeId,
		positionId: card.positionId ?? '',
		date: calendarDateOf(card.clockInAt, zone),
		start: timeInputOf(card.clockInAt, zone),
		end: card.clockOutAt === null ? '' : timeInputOf(card.clockOutAt, zone),
		breaks: card.breaks.map((item) => ({
			key: newBreakKey(),
			kind: item.kind,
			start: timeInputOf(item.startAt, zone),
			end: item.endAt === null ? '' : timeInputOf(item.endAt, zone),
		})),
		cashTips: card.money ? minorToInput(card.money.cashTipsMinor) : '',
		creditTips: card.money ? minorToInput(card.money.creditTipsMinor) : '',
		note: card.managerNote ?? '',
		reason: '',
	}
}

const isTime = (value: string) => LOCAL_TIME_PATTERN.test(value)

/**
 * Clock-in and clock-out instants from the date and the two times of day. An
 * end that is not after the start belongs to the next day (a night shift).
 * Null while the form has not got usable times yet. `clockOutAt` is null when
 * the end is blank (a card that is still open).
 */
export function resolveCardTimes(
	form: Pick<CardForm, 'date' | 'start' | 'end'>,
	timeZone: string,
): { clockInAt: number; clockOutAt: number | null } | null {
	if (!isValidDate(form.date) || !isTime(form.start)) return null
	if (form.end === '') {
		return {
			clockInAt: localTimeToInstant(form.date, form.start, timeZone),
			clockOutAt: null,
		}
	}
	if (!isTime(form.end)) return null
	return resolveLocalCardTimes(
		{ date: form.date, startTime: form.start, endTime: form.end },
		timeZone,
	)
}

export type ResolvedBreak = { startAt: number; endAt: number }

/** Break instants for the rows that have both times, in card order. */
export function resolveBreaks(
	breaks: readonly BreakForm[],
	clockInAt: number,
	timeZone: string,
): Array<ResolvedBreak | null> {
	return breaks.map((item) =>
		isTime(item.start) && isTime(item.end)
			? resolveLocalBreakTimes(
					{ startTime: item.start, endTime: item.end },
					clockInAt,
					timeZone,
				)
			: null,
	)
}

export type FormErrors = Record<string, string>

export function breakErrorKey(key: string): string {
	return `break:${key}`
}

/** The reason must say something: not blank, not only invisible characters. */
export function isMeaningfulReason(value: string): boolean {
	return /[\p{L}\p{N}]/u.test(value.trim())
}

export type ValidateOptions = {
	mode: 'create' | 'edit'
	timeZone: string
	/** The server's "now", so a wrong device clock cannot let a future time through. */
	now: number
	/** The card being edited, if any: a card that was open may stay open. */
	original?: Pick<TimesheetCardRow, 'clockOutAt'> | null
	/** Tips are money: only checked when the viewer holds the pay grant. */
	moneyVisible: boolean
	/** The person holds several roles here, so one must be picked. */
	positionRequired?: boolean
}

export function validateCardForm(
	form: CardForm,
	options: ValidateOptions,
	translate: Translate,
): FormErrors {
	const errors: FormErrors = {}
	const { timeZone, now } = options

	if (options.mode === 'create') {
		if (!form.scopeId) errors.scopeId = translate(msg`Choose a workplace.`)
		if (!form.staffId) errors.staffId = translate(msg`Choose who worked.`)
		if (options.positionRequired && !form.positionId) {
			errors.positionId = translate(msg`Choose which position they worked.`)
		}
	}
	if (!isValidDate(form.date)) errors.date = translate(msg`Enter a date.`)
	if (!isTime(form.start)) errors.start = translate(msg`Enter the start time.`)

	const mustEnd =
		options.mode === 'create' || options.original?.clockOutAt != null
	if (form.end === '' && mustEnd) {
		errors.end = translate(msg`Enter the end time.`)
	} else if (form.end !== '' && !isTime(form.end)) {
		errors.end = translate(msg`Enter the end time.`)
	}

	const times = resolveCardTimes(form, timeZone)
	if (times && !errors.date && !errors.start && !errors.end) {
		if (times.clockInAt > now) {
			errors.start = translate(msg`That start time has not happened yet.`)
		} else if (times.clockOutAt !== null && times.clockOutAt > now) {
			errors.end = translate(msg`That end time has not happened yet.`)
		} else if (
			times.clockOutAt !== null &&
			(times.clockOutAt - times.clockInAt) / 60_000 > MAX_CARD_MINUTES
		) {
			errors.end = translate(msg`A time card cannot be longer than 48 hours.`)
		}
	}

	if (form.breaks.length > 0 && times && times.clockOutAt === null) {
		errors.end ??= translate(msg`Add the end time before adding breaks.`)
	}

	if (times && times.clockOutAt !== null) {
		const placed: Array<{ key: string; at: ResolvedBreak }> = []
		for (const item of form.breaks) {
			const key = breakErrorKey(item.key)
			if (!isTime(item.start) || !isTime(item.end)) {
				errors[key] = translate(msg`Enter when the break started and ended.`)
				continue
			}
			const at = resolveLocalBreakTimes(
				{ startTime: item.start, endTime: item.end },
				times.clockInAt,
				timeZone,
			)
			if (at.startAt < times.clockInAt || at.endAt > times.clockOutAt) {
				errors[key] = translate(msg`The break has to fall inside the shift.`)
			} else if (at.endAt > now) {
				errors[key] = translate(msg`That break has not happened yet.`)
			} else {
				placed.push({ key, at })
			}
		}
		placed.sort((a, b) => a.at.startAt - b.at.startAt)
		for (let i = 1; i < placed.length; i += 1) {
			if (placed[i]!.at.startAt < placed[i - 1]!.at.endAt) {
				errors[placed[i]!.key] ??= translate(
					msg`Breaks cannot overlap each other.`,
				)
			}
		}
	} else {
		// No end yet: a row can still be half filled, but each one needs both times.
		for (const item of form.breaks) {
			if (!isTime(item.start) || !isTime(item.end)) {
				errors[breakErrorKey(item.key)] = translate(
					msg`Enter when the break started and ended.`,
				)
			}
		}
	}

	if (options.moneyVisible) {
		for (const field of ['cashTips', 'creditTips'] as const) {
			const value = form[field].trim()
			if (value !== '' && parseMoneyToMinor(value) === null) {
				errors[field] = translate(msg`Enter an amount like 12.50.`)
			}
		}
	}
	if (form.note.trim().length > 1000) {
		errors.note = translate(msg`Use 1000 characters or fewer.`)
	}
	if (!isMeaningfulReason(form.reason)) {
		errors.reason = translate(
			msg`Say what changed and why. It is kept with the card.`,
		)
	} else if (form.reason.trim().length > 500) {
		errors.reason = translate(msg`Use 500 characters or fewer.`)
	}
	return errors
}

function breaksBody(form: CardForm) {
	return form.breaks.map((item) => ({
		kind: item.kind,
		startTime: item.start,
		endTime: item.end,
	}))
}

export function buildCreateBody(form: CardForm, moneyVisible: boolean) {
	const cash = parseMoneyToMinor(form.cashTips)
	const credit = parseMoneyToMinor(form.creditTips)
	return {
		staffId: form.staffId,
		scopeId: form.scopeId,
		...(form.positionId ? { positionId: form.positionId } : {}),
		date: form.date,
		startTime: form.start,
		endTime: form.end,
		breaks: breaksBody(form),
		...(moneyVisible && cash !== null ? { cashTipsMinor: cash } : {}),
		...(moneyVisible && credit !== null ? { creditTipsMinor: credit } : {}),
		...(form.note.trim() ? { managerNote: form.note.trim() } : {}),
		reason: form.reason.trim(),
	}
}

/**
 * Only what changed, as the update endpoint wants it: instants for the
 * clock-in and clock-out (resolved in the card's zone), the full break list
 * when any break changed, tips in minor units, the note (`null` clears it).
 * `changed` is false when the manager has not actually changed anything.
 */
export function buildUpdateBody(
	card: TimesheetCardRow,
	form: CardForm,
	moneyVisible: boolean,
): { changed: boolean; body: Record<string, unknown> } {
	const body: Record<string, unknown> = {
		expectedVersion: card.version,
		reason: form.reason.trim(),
	}
	let changed = false
	// What the form showed when it opened. A time of day that was not touched
	// keeps the card's own instant: typed text cannot tell the two 1:30s of a
	// clock-change night apart, so re-resolving it would quietly move the punch
	// an hour.
	const initial = cardToForm(card)
	const startedSame = form.date === initial.date && form.start === initial.start
	const endedSame = form.end === initial.end && form.date === initial.date
	const resolved = resolveCardTimes(form, card.timeZone)
	const times = resolved
		? {
				clockInAt: startedSame ? card.clockInAt : resolved.clockInAt,
				clockOutAt:
					endedSame && startedSame ? card.clockOutAt : resolved.clockOutAt,
			}
		: null
	if (times) {
		if (times.clockInAt !== card.clockInAt) {
			body.clockInAt = times.clockInAt
			changed = true
		}
		if (times.clockOutAt !== null && times.clockOutAt !== card.clockOutAt) {
			body.clockOutAt = times.clockOutAt
			changed = true
		}
	}
	if (times) {
		const breaksSame =
			form.breaks.length === initial.breaks.length &&
			form.breaks.every((item, index) => {
				const before = initial.breaks[index]!
				return (
					item.kind === before.kind &&
					item.start === before.start &&
					item.end === before.end
				)
			})
		const next = resolveBreaks(form.breaks, times.clockInAt, card.timeZone)
		const same =
			breaksSame ||
			(next.length === card.breaks.length &&
				next.every((item, index) => {
					const before = card.breaks[index]
					return (
						item !== null &&
						before !== undefined &&
						item.startAt === before.startAt &&
						item.endAt === before.endAt &&
						form.breaks[index]!.kind === before.kind
					)
				}))
		if (!same) {
			body.breaks = breaksBody(form)
			changed = true
		}
	}
	if (form.positionId && form.positionId !== (card.positionId ?? '')) {
		body.positionId = form.positionId
		changed = true
	}
	if (moneyVisible && card.money) {
		const cash = parseMoneyToMinor(form.cashTips)
		const credit = parseMoneyToMinor(form.creditTips)
		const cashNext = form.cashTips.trim() === '' ? 0 : cash
		const creditNext = form.creditTips.trim() === '' ? 0 : credit
		if (cashNext !== null && cashNext !== card.money.cashTipsMinor) {
			body.cashTipsMinor = cashNext
			changed = true
		}
		if (creditNext !== null && creditNext !== card.money.creditTipsMinor) {
			body.creditTipsMinor = creditNext
			changed = true
		}
	}
	const note = form.note.trim()
	if (note !== (card.managerNote ?? '')) {
		body.managerNote = note === '' ? null : note
		changed = true
	}
	return { changed, body }
}

/** Quick reasons a manager can tap instead of typing. Plain, not legal wording. */
export const REASON_SUGGESTIONS = [
	msg`Forgot to clock out`,
	msg`Wrong time entered`,
	msg`Missed punch`,
	msg`Break not recorded`,
	msg`Added a shift`,
] as const
