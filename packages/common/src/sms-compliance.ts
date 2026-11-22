import { localParts, parseDate, zonedLocalToUtc } from '@repo/zoned-time'

/**
 * Marketing text rules shared by tenant-api (the send path and the inbound
 * webhook) and the App composer (#75): the keywords a guest can reply with, the
 * opt-out footer every marketing text ends with, the segment count that
 * includes it, and the quiet hours. Pure and dependency-light: no I/O.
 */

export type SmsKeyword = 'stop' | 'start' | 'help'

// Matched on the WHOLE trimmed body, case-insensitive. A sentence that merely
// contains the word ("please don't stop") is not a keyword.
const STOP_WORDS = new Set([
	'stop',
	'stopall',
	'unsubscribe',
	'cancel',
	'end',
	'quit',
])
const START_WORDS = new Set(['start', 'yes', 'unstop'])
const HELP_WORDS = new Set(['help', 'info'])

/** The keyword a reply is, or null when it is anything else. */
export function matchSmsKeyword(body: string | null | undefined): SmsKeyword | null {
	if (typeof body !== 'string') return null
	const word = body.trim().toLowerCase()
	if (!word) return null
	if (STOP_WORDS.has(word)) return 'stop'
	if (START_WORDS.has(word)) return 'start'
	if (HELP_WORDS.has(word)) return 'help'
	return null
}

/** The phrase every marketing text ends with. Carriers expect the English keyword. */
export const SMS_OPT_OUT_PHRASE = 'Reply STOP to opt out.'

const FOOTER_PATTERN = /reply stop to (opt out|unsubscribe)\.?\s*$/i

/** The text with the opt-out phrase on its own last line (once). */
export function withSmsOptOutFooter(text: string): string {
	const trimmed = text.replace(/\s+$/u, '')
	if (FOOTER_PATTERN.test(trimmed)) return trimmed
	return trimmed ? `${trimmed}\n${SMS_OPT_OUT_PHRASE}` : SMS_OPT_OUT_PHRASE
}

// GSM 03.38 basic set and its escape (two septet) extension.
const GSM_BASIC =
	'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM_EXTENDED = '^{}\\[~]|€\f'

export type SmsSegmentCount = {
	/** Characters as the carrier counts them (GSM extension characters count 2). */
	units: number
	segments: number
	encoding: 'gsm' | 'ucs2'
}

/** How many text segments a message uses: 160 (153 joined) in GSM-7, 70 (67) otherwise. */
export function countSmsSegments(text: string): SmsSegmentCount {
	let gsmUnits = 0
	let gsm = true
	for (const char of text) {
		if (GSM_BASIC.includes(char)) gsmUnits += 1
		else if (GSM_EXTENDED.includes(char)) gsmUnits += 2
		else {
			gsm = false
			break
		}
	}
	if (gsm) {
		return {
			units: gsmUnits,
			encoding: 'gsm',
			segments: gsmUnits === 0 ? 0 : gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153),
		}
	}
	// UCS-2 counts UTF-16 code units (an emoji is two).
	const units = text.length
	return {
		units,
		encoding: 'ucs2',
		segments: units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67),
	}
}

/** The segments the guest is billed for: the text WITH its footer. */
export function countMarketingSmsSegments(text: string): SmsSegmentCount {
	return countSmsSegments(withSmsOptOutFooter(text))
}

/** Quiet hours: marketing texts go out from 9:00 up to (not including) 20:00 local time. */
export const SMS_WINDOW_START_HOUR = 9
export const SMS_WINDOW_END_HOUR = 20

export type SmsSendWindow = {
	/** Whether `now` is inside the window. */
	open: boolean
	/** The instant a send held now may go out: `now` when open, else the next 9:00. */
	notBefore: number
}

/**
 * Where `now` sits against the 9:00 to 20:00 window in `timeZone`. Built on the
 * zone's wall clock, so a daylight saving change moves the instant but never
 * the local hours. A deferred send is never dropped: `notBefore` is the next
 * time the window opens.
 */
export function smsSendWindow(now: number, timeZone: string): SmsSendWindow {
	const local = localParts(now, timeZone)
	const minutes = local.hour * 60 + local.minute
	if (
		minutes >= SMS_WINDOW_START_HOUR * 60 &&
		minutes < SMS_WINDOW_END_HOUR * 60
	) {
		return { open: true, notBefore: now }
	}
	const date = `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`
	// Before 9:00 the window opens today; from 20:00 it opens tomorrow.
	const day = minutes < SMS_WINDOW_START_HOUR * 60 ? date : nextDate(date)
	const { year, month, day: dayOfMonth } = parseDate(day)
	return {
		open: false,
		notBefore: zonedLocalToUtc(
			year,
			month,
			dayOfMonth,
			SMS_WINDOW_START_HOUR,
			0,
			timeZone,
		),
	}
}

function nextDate(date: string): string {
	const { year, month, day } = parseDate(date)
	const next = new Date(Date.UTC(year, month - 1, day + 1))
	return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

/** The replies tenant-api sends. Plain words, no links, one segment where it can. */
export function smsReplyText(
	kind: SmsKeyword,
	organizationName: string,
): string {
	const name = organizationName.trim() || 'this restaurant'
	switch (kind) {
		case 'stop':
			return `${name}: you are unsubscribed and will get no more texts from us. Reply START to subscribe again.`
		case 'start':
			return `${name}: you are subscribed again. Reply STOP to opt out, HELP for help.`
		case 'help':
			return `${name}: you get texts from us because you agreed to. Reply STOP to opt out, START to subscribe again.`
	}
}
