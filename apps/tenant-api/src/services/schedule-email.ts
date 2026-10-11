import { type PublishedShift } from '@repo/tenant-db'

export type ScheduleEmailLocale = 'en' | 'ar'

// tenant-api has no Lingui catalog. These strings are the only staff-facing
// copy this node sends; App passes the publisher's UI locale.
const COPY = {
	en: {
		subject: (location: string, week: string) =>
			`Your schedule at ${location} for the week of ${week}`,
		greeting: (name: string) => `Hi ${name},`,
		intro: (location: string, week: string) =>
			`Your schedule at ${location} for the week of ${week} was published.`,
		none: 'You have no shifts this week.',
		removed: 'No longer scheduled:',
		breakMinutes: (minutes: number) => `${minutes} min unpaid break`,
		footer:
			'Reply to your manager if something looks wrong. Shift times are in the location’s local time.',
	},
	ar: {
		subject: (location: string, week: string) =>
			`جدولك في ${location} لأسبوع ${week}`,
		greeting: (name: string) => `مرحبًا ${name}،`,
		intro: (location: string, week: string) =>
			`تم نشر جدولك في ${location} لأسبوع ${week}.`,
		none: 'ليس لديك مناوبات هذا الأسبوع.',
		removed: 'لم تعد مجدولًا في:',
		breakMinutes: (minutes: number) => `استراحة غير مدفوعة ${minutes} دقيقة`,
		footer:
			'تواصل مع مديرك إذا لاحظت خطأً. أوقات المناوبات بالتوقيت المحلي للفرع.',
	},
} as const

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function intlLocale(locale: ScheduleEmailLocale) {
	return locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US'
}

/** Wall-clock values are formatted as UTC so no zone conversion happens. */
function wallDate(localDate: string, time = '00:00') {
	return new Date(`${localDate}T${time}:00Z`)
}

function formatDay(localDate: string, locale: ScheduleEmailLocale) {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		weekday: 'long',
		month: 'short',
		day: 'numeric',
	}).format(wallDate(localDate))
}

function formatTime(
	localDate: string,
	time: string,
	locale: ScheduleEmailLocale,
) {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		timeZone: 'UTC',
		hour: 'numeric',
		minute: '2-digit',
	}).format(wallDate(localDate, time))
}

function describeShift(
	shift: PublishedShift,
	locale: ScheduleEmailLocale,
	positions: ReadonlyMap<string, string>,
) {
	const parts = [
		`${formatTime(shift.localDate, shift.startTime, locale)} – ${formatTime(
			shift.localDate,
			shift.endTime,
			locale,
		)}`,
	]
	const position = shift.positionId ? positions.get(shift.positionId) : null
	if (position) parts.push(position)
	if (shift.unpaidBreakMinutes > 0) {
		parts.push(COPY[locale].breakMinutes(shift.unpaidBreakMinutes))
	}
	return {
		day: formatDay(shift.localDate, locale),
		detail: parts.join(' · '),
		note: shift.note,
	}
}

export function buildScheduleEmail(input: {
	locale: ScheduleEmailLocale
	firstName: string
	locationName: string
	weekStart: string
	current: readonly PublishedShift[]
	removed: readonly PublishedShift[]
	positions: ReadonlyMap<string, string>
}) {
	const copy = COPY[input.locale]
	const week = formatDay(input.weekStart, input.locale)
	const rows = input.current.map((shift) =>
		describeShift(shift, input.locale, input.positions),
	)
	const removed = input.removed.map((shift) =>
		describeShift(shift, input.locale, input.positions),
	)
	const dir = input.locale === 'ar' ? 'rtl' : 'ltr'

	const text = [
		copy.greeting(input.firstName),
		'',
		copy.intro(input.locationName, week),
		'',
		...(rows.length
			? rows.map(
					(row) =>
						`${row.day}: ${row.detail}${row.note ? ` (${row.note})` : ''}`,
				)
			: [copy.none]),
		...(removed.length
			? ['', copy.removed, ...removed.map((row) => `${row.day}: ${row.detail}`)]
			: []),
		'',
		copy.footer,
	].join('\n')

	const rowHtml = (row: ReturnType<typeof describeShift>, muted = false) =>
		`<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:${
			muted ? '#6b7280' : '#111827'
		}">${escapeHtml(row.day)}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${
			muted ? '#6b7280' : '#111827'
		}${muted ? ';text-decoration:line-through' : ''}">${escapeHtml(row.detail)}${
			row.note
				? `<br><span style="color:#6b7280;font-size:13px">${escapeHtml(row.note)}</span>`
				: ''
		}</td></tr>`

	const html = `<!doctype html><html lang="${input.locale}" dir="${dir}"><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px"><p style="margin:0 0 12px">${escapeHtml(
		copy.greeting(input.firstName),
	)}</p><p style="margin:0 0 16px">${escapeHtml(
		copy.intro(input.locationName, week),
	)}</p>${
		rows.length
			? `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows
					.map((row) => rowHtml(row))
					.join('')}</table>`
			: `<p style="margin:0 0 16px">${escapeHtml(copy.none)}</p>`
	}${
		removed.length
			? `<p style="margin:16px 0 8px;font-weight:600">${escapeHtml(
					copy.removed,
				)}</p><table style="width:100%;border-collapse:collapse;font-size:14px">${removed
					.map((row) => rowHtml(row, true))
					.join('')}</table>`
			: ''
	}<p style="margin:16px 0 0;color:#6b7280;font-size:13px">${escapeHtml(
		copy.footer,
	)}</p></div></body></html>`

	return {
		subject: copy.subject(input.locationName, week).replace(/[\r\n]+/g, ' '),
		text,
		html,
	}
}
