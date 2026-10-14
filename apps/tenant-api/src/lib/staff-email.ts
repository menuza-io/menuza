import { brand } from '@repo/config/brand'
import {
	addDays,
	type ContactLevel,
	type ScheduleNotifyMode,
	type StaffOutboxKind,
} from '@repo/staffing'

/**
 * Staff email, rendered as plain HTML strings.
 *
 * Staff messages are sent from tenant-api, which also runs inside a Durable
 * Object on the US node, so there is no React here, and no CSS variables or
 * `oklch()` (mail clients support neither): colors are plain hex and the layout
 * is one table with inline styles. They are sent without a marketing context, so
 * no campaign or unsubscribe headers are attached; this is operational mail
 * about a person's own work, not marketing.
 *
 * `full` names the scope and the times. `minimal` is a generic line with no
 * name, place or time in it (the default for Saudi organizations). Every
 * dynamic value is escaped, and nothing here ever includes pay.
 */

export type StaffEmailLocale = 'en' | 'ar'

export type StaffEmailInput = {
	kind: StaffOutboxKind
	level: ContactLevel
	locale: StaffEmailLocale
	firstName: string
	scopeName: string | null
	/** IANA zone of the scope; times are shown in it. */
	timeZone: string | null
	payload: Record<string, unknown>
}

export type RenderedStaffEmail = { subject: string; text: string; html: string }

const COLORS = {
	page: '#f4f3ef',
	card: '#ffffff',
	text: '#1d1c1a',
	muted: '#6a6862',
	border: '#e2dfd7',
	accent: '#1d1c1a',
} as const

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

export function normalizeStaffLocale(value: unknown): StaffEmailLocale {
	return typeof value === 'string' && value.toLowerCase().startsWith('ar')
		? 'ar'
		: 'en'
}

function intlLocale(locale: StaffEmailLocale): string {
	// Latin digits in Arabic too: they are what a Saudi rota and a time card show.
	return locale === 'ar' ? 'ar-u-nu-latn' : 'en-US'
}

function safeZone(timeZone: string | null): string {
	if (!timeZone) return 'UTC'
	try {
		new Intl.DateTimeFormat('en-US', { timeZone })
		return timeZone
	} catch {
		return 'UTC'
	}
}

export function formatTime(
	ms: number,
	timeZone: string | null,
	locale: StaffEmailLocale,
): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: safeZone(timeZone),
	}).format(new Date(ms))
}

export function formatDay(
	ms: number,
	timeZone: string | null,
	locale: StaffEmailLocale,
): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: safeZone(timeZone),
	}).format(new Date(ms))
}

/** A business date (`YYYY-MM-DD`) shown without any time zone shift. */
export function formatLocalDate(
	date: string,
	locale: StaffEmailLocale,
): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
	if (!match) return ''
	const noon = Date.UTC(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		12,
	)
	return new Intl.DateTimeFormat(intlLocale(locale), {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(noon))
}

/** `90` -> "1 h 30 min", `-30` -> "-30 min". */
export function formatMinutes(
	minutes: number,
	locale: StaffEmailLocale,
): string {
	const sign = minutes < 0 ? '-' : ''
	const abs = Math.abs(Math.round(minutes))
	const h = Math.floor(abs / 60)
	const m = abs % 60
	const hUnit = locale === 'ar' ? 'س' : 'h'
	const mUnit = locale === 'ar' ? 'د' : 'min'
	const parts: string[] = []
	if (h > 0) parts.push(`${h} ${hUnit}`)
	if (m > 0 || h === 0) parts.push(`${m} ${mUnit}`)
	return `${sign}${parts.join(' ')}`
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

type Copy = { subject: string; lines: string[] }

const MINIMAL: Record<StaffEmailLocale, Copy> = {
	en: {
		subject: 'An update about your time',
		lines: [
			'There is an update about your shifts or your time card.',
			'Please check with your manager.',
		],
	},
	ar: {
		subject: 'تحديث بخصوص وقتك',
		lines: ['هناك تحديث بخصوص ورديتك أو بطاقة وقتك.', 'يرجى مراجعة مديرك.'],
	},
}

function fullCopy(input: StaffEmailInput): Copy {
	const { locale, kind, payload } = input
	const tz = input.timeZone
	const name = input.firstName.trim()
	const place =
		input.scopeName?.trim() ||
		(locale === 'ar' ? 'مكان عملك' : 'your workplace')
	const hello = locale === 'ar' ? `مرحبًا ${name}،` : `Hi ${name},`

	if (kind === 'time_card_edited') {
		const date = formatLocalDate(String(payload.localDate ?? ''), locale)
		const delta = num(payload.hoursDeltaMinutes)
		const deltaLine =
			delta !== null && delta !== 0
				? locale === 'ar'
					? `تغيّر عدد ساعاتك بمقدار ${formatMinutes(delta, locale)}.`
					: `Your hours changed by ${formatMinutes(delta, locale)}.`
				: null
		return locale === 'ar'
			? {
					subject: 'تم تحديث بطاقة وقتك',
					lines: [
						`${hello} قام أحد المديرين بتحديث بطاقة وقتك${date ? ` ليوم ${date}` : ''}.`,
						...(deltaLine ? [deltaLine] : []),
						'إذا بدا لك أن هناك خطأ، يرجى التواصل مع مديرك.',
					],
				}
			: {
					subject: 'Your time card was updated',
					lines: [
						`${hello} a manager updated your time card${date ? ` for ${date}` : ''}.`,
						...(deltaLine ? [deltaLine] : []),
						'If something looks wrong, please talk to your manager.',
					],
				}
	}

	if (kind === 'shift_reminder') {
		const start = num(payload.startAt)
		const end = num(payload.endAt)
		if (start === null) return MINIMAL[locale]
		const time = formatTime(start, tz, locale)
		const day = formatDay(start, tz, locale)
		const endTime = end === null ? null : formatTime(end, tz, locale)
		return locale === 'ar'
			? {
					subject: `تذكير: تبدأ ورديتك الساعة ${time}`,
					lines: [
						`${hello} تبدأ ورديتك في ${place} الساعة ${time} (${day})${endTime ? ` وتنتهي الساعة ${endTime}` : ''}.`,
					],
				}
			: {
					subject: `Reminder: your shift starts at ${time}`,
					lines: [
						`${hello} your shift at ${place} starts at ${time} on ${day}${endTime ? ` and ends at ${endTime}` : ''}.`,
					],
				}
	}

	if (kind === 'missed_clock_out_reminder') {
		const clockIn = num(payload.clockInAt)
		if (clockIn === null) return MINIMAL[locale]
		const time = formatTime(clockIn, tz, locale)
		return locale === 'ar'
			? {
					subject: 'هل نسيت تسجيل الانصراف؟',
					lines: [
						`${hello} سجّلت حضورك في ${place} الساعة ${time} ولم نجد تسجيل انصراف.`,
						'إذا انتهت ورديتك، يرجى إبلاغ مديرك ليصحّح بطاقة وقتك.',
					],
				}
			: {
					subject: 'Did you forget to clock out?',
					lines: [
						`${hello} you clocked in at ${place} at ${time} and we have not seen a clock-out.`,
						'If your shift is over, please tell your manager so they can fix your time card.',
					],
				}
	}

	// auto_clock_out_notice
	const clockIn = num(payload.clockInAt)
	const clockOut = num(payload.clockOutAt)
	if (clockIn === null || clockOut === null) return MINIMAL[locale]
	const inTime = formatTime(clockIn, tz, locale)
	const outTime = formatTime(clockOut, tz, locale)
	return locale === 'ar'
		? {
				subject: 'تم تسجيل انصرافك تلقائيًا',
				lines: [
					`${hello} أُغلقت ورديتك في ${place} التي بدأت الساعة ${inTime} تلقائيًا الساعة ${outTime} لعدم تسجيل انصراف.`,
					'سيراجعها مديرك.',
				],
			}
		: {
				subject: 'You were clocked out automatically',
				lines: [
					`${hello} your shift at ${place} that began at ${inTime} was closed automatically at ${outTime} because no clock-out was recorded.`,
					'Your manager will review it.',
				],
			}
}

type Cta = { label: string; url: string }

function isHttpUrl(value: string): boolean {
	return /^https?:\/\/[^\s"'<>]+$/i.test(value)
}

export function layout(
	locale: StaffEmailLocale,
	subject: string,
	lines: string[],
	cta: Cta | null = null,
	footerOverride: string | null = null,
): { html: string; text: string } {
	const dir = locale === 'ar' ? 'rtl' : 'ltr'
	const align = locale === 'ar' ? 'right' : 'left'
	const font =
		"-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans Arabic', sans-serif"
	const footer =
		footerOverride ??
		(locale === 'ar'
			? `أُرسلت من ${brand.shortName}. هذه رسالة تشغيلية عن عملك.`
			: `Sent by ${brand.shortName}. This is an operational message about your work.`)
	const body = lines
		.map(
			(line) =>
				`<p style="margin:0 0 14px 0;font-size:16px;line-height:24px;color:${COLORS.text};text-align:${align};">${escapeHtml(line)}</p>`,
		)
		.join('')
	const safeCta = cta && isHttpUrl(cta.url) ? cta : null
	const button = safeCta
		? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px 0;"><tr><td style="background:${COLORS.accent};border-radius:6px;"><a href="${escapeHtml(safeCta.url)}" style="display:inline-block;padding:13px 22px;font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;font-family:${font};">${escapeHtml(safeCta.label)}</a></td></tr></table>`
		: ''
	const html =
		`<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width, initial-scale=1">` +
		`<title>${escapeHtml(subject)}</title></head>` +
		`<body style="margin:0;padding:0;background:${COLORS.page};">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};"><tr><td align="center" style="padding:24px 12px;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;"><tr><td dir="${dir}" style="padding:28px 24px;font-family:${font};text-align:${align};">` +
		`<h1 style="margin:0 0 16px 0;font-size:20px;line-height:28px;color:${COLORS.text};font-weight:600;text-align:${align};">${escapeHtml(subject)}</h1>` +
		body +
		button +
		`<p style="margin:20px 0 0 0;padding-top:14px;border-top:1px solid ${COLORS.border};font-size:13px;line-height:20px;color:${COLORS.muted};text-align:${align};">${escapeHtml(footer)}</p>` +
		`</td></tr></table></td></tr></table></body></html>`
	const link = safeCta ? `${safeCta.label}: ${safeCta.url}\n\n` : ''
	const text = `${subject}\n\n${lines.join('\n\n')}\n\n${link}${footer}\n`
	return { html, text }
}

export function renderStaffEmail(input: StaffEmailInput): RenderedStaffEmail {
	if (input.kind === 'schedule_published') {
		// The real message is built from the live schedule by
		// `renderScheduleEmail`; this is the safe generic fallback.
		return renderScheduleEmail({
			level: 'minimal',
			locale: input.locale,
			firstName: input.firstName,
			scopeName: input.scopeName,
			timeZone: input.timeZone,
			weekStart: '2000-01-03',
			version: 0,
			mode: 'changed',
			shifts: [],
			removed: [],
			linkUrl: null,
		})
	}
	const copy =
		input.level === 'minimal' ? MINIMAL[input.locale] : fullCopy(input)
	const { html, text } = layout(input.locale, copy.subject, copy.lines)
	return { subject: copy.subject, html, text }
}

// ---------------------------------------------------------------------------
// Schedule published
// ---------------------------------------------------------------------------

export type ScheduleEmailShift = {
	startsAt: number
	endsAt: number
	positionName: string | null
	/** What this publication did to the shift for this person. */
	change: 'new' | 'changed' | 'same'
}

export type ScheduleEmailInput = {
	level: ContactLevel
	locale: StaffEmailLocale
	firstName: string
	scopeName: string | null
	timeZone: string | null
	/** First day of the week the publication covers (`YYYY-MM-DD`). */
	weekStart: string
	version: number
	mode: ScheduleNotifyMode
	/**
	 * The recipient's own live shifts for that week, and nothing else: the caller
	 * selects them by person, so no other person's name, time or position can be
	 * here.
	 */
	shifts: ScheduleEmailShift[]
	/** Their own shifts that were removed or given to someone else. */
	removed: Array<
		Pick<ScheduleEmailShift, 'startsAt' | 'endsAt' | 'positionName'>
	>
	/** The capability link, or `null` when this node has no public App address. */
	linkUrl: string | null
}

function shiftLine(
	shift: Pick<ScheduleEmailShift, 'startsAt' | 'endsAt' | 'positionName'>,
	timeZone: string | null,
	locale: StaffEmailLocale,
): string {
	const day = formatDay(shift.startsAt, timeZone, locale)
	const start = formatTime(shift.startsAt, timeZone, locale)
	const end = formatTime(shift.endsAt, timeZone, locale)
	const role = shift.positionName?.trim()
	return `${day}, ${start} - ${end}${role ? ` (${role})` : ''}`
}

const SCHEDULE_COPY = {
	en: {
		subjectNew: 'Your schedule is ready',
		subjectUpdated: 'Your schedule was updated',
		subjectMinimal: 'An update about your schedule',
		minimal: 'There is an update to your schedule.',
		minimalAsk: 'Open it to see your shifts.',
		cta: 'View my schedule',
		noShifts: 'You have no shifts this week.',
		weekOf: 'week of',
		removed: 'No longer on your schedule:',
		newTag: 'new',
		changedTag: 'changed',
		linkNote:
			'This link is only for you. Anyone who has it can see your schedule, so please do not forward it.',
		noLink: 'Please check with your manager for your shifts.',
	},
	ar: {
		subjectNew: 'جدولك جاهز',
		subjectUpdated: 'تم تحديث جدولك',
		subjectMinimal: 'تحديث بخصوص جدولك',
		minimal: 'هناك تحديث على جدولك.',
		minimalAsk: 'افتحه لرؤية ورديتك.',
		cta: 'عرض جدولي',
		noShifts: 'ليس لديك ورديات هذا الأسبوع.',
		weekOf: 'أسبوع',
		removed: 'لم تعد في جدولك:',
		newTag: 'جديدة',
		changedTag: 'معدّلة',
		linkNote:
			'هذا الرابط خاص بك. أي شخص لديه الرابط يستطيع رؤية جدولك، فلا تشاركه.',
		noLink: 'يرجى مراجعة مديرك لمعرفة ورديتك.',
	},
} as const

/**
 * The email that tells one person about a published week. At the `full` level it
 * lists that person's own shifts (never anyone else's) and names the place; at
 * `minimal` it says only that there is an update. Either way it carries the
 * read-only link to their own schedule, and never any pay.
 */
export function renderScheduleEmail(
	input: ScheduleEmailInput,
): RenderedStaffEmail {
	const copy = SCHEDULE_COPY[input.locale]
	const cta: Cta | null =
		input.linkUrl && isHttpUrl(input.linkUrl)
			? { label: copy.cta, url: input.linkUrl }
			: null
	const tail = cta ? [copy.linkNote] : [copy.noLink]

	if (input.level === 'minimal') {
		const lines = [copy.minimal, cta ? copy.minimalAsk : copy.noLink]
		const { html, text } = layout(
			input.locale,
			copy.subjectMinimal,
			cta ? [...lines, copy.linkNote] : lines,
			cta,
		)
		return { subject: copy.subjectMinimal, html, text }
	}

	const name = input.firstName.trim()
	const hello = input.locale === 'ar' ? `مرحبًا ${name}،` : `Hi ${name},`
	const place =
		input.scopeName?.trim() ||
		(input.locale === 'ar' ? 'مكان عملك' : 'your workplace')
	const first = formatLocalDate(input.weekStart, input.locale)
	const last = formatLocalDate(addDays(input.weekStart, 6), input.locale)
	const period = `${first} - ${last}`
	const subject =
		input.version <= 1 && input.mode === 'everyone'
			? copy.subjectNew
			: copy.subjectUpdated

	const intro =
		input.locale === 'ar'
			? `${hello} هذا جدولك في ${place} (${copy.weekOf} ${period}).`
			: `${hello} here is your schedule at ${place} (${copy.weekOf} ${period}).`
	const lines: string[] = [intro]
	if (input.shifts.length === 0) lines.push(copy.noShifts)
	for (const shift of input.shifts) {
		const tag =
			shift.change === 'new'
				? ` [${copy.newTag}]`
				: shift.change === 'changed'
					? ` [${copy.changedTag}]`
					: ''
		lines.push(`${shiftLine(shift, input.timeZone, input.locale)}${tag}`)
	}
	if (input.removed.length > 0) {
		lines.push(copy.removed)
		for (const shift of input.removed) {
			lines.push(shiftLine(shift, input.timeZone, input.locale))
		}
	}
	lines.push(...tail)
	const { html, text } = layout(input.locale, subject, lines, cta)
	return { subject, html, text }
}
