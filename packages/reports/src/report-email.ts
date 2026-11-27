import { escapeXml } from './export.ts'
import {
	FIGURES,
	figureChangePercent,
	type FigureEntry,
	type FigureFormat,
	type FigureId,
	type FigureValue,
} from './summary-figures.ts'

/**
 * Plain HTML and text for the report emails (#121 scheduled reports and the
 * daily summary, #221 the monthly results): one small renderer for all of
 * them, so no email needs its own template engine. Pure; every value is
 * escaped, and a link is only ever one of the three the caller names.
 * Emails carry totals and report rows the recipient may already read, never a
 * guest name, phone or email unless the report itself holds one (a scheduled
 * report may not: see `personal-fields.ts`).
 */

export type EmailLocale = 'en' | 'ar'

const COPY = {
	en: {
		openReport: 'Open this report',
		downloadCsv: 'Download CSV',
		unsubscribe: 'Unsubscribe from this email',
		because: (org: string) =>
			`You receive this because you are a member of ${org}.`,
		csvNote: 'The CSV link works for 2 days.',
		cut: (n: number) =>
			`Showing the first ${n} rows. Download the CSV for the rest.`,
		noData: 'No data for this period.',
		same: 'no change',
		up: (p: string) => `up ${p}`,
		down: (p: string) => `down ${p}`,
		estimate: 'Estimate',
		notSwitchedOn: 'Not switched on yet',
	},
	ar: {
		openReport: 'افتح هذا التقرير',
		downloadCsv: 'تنزيل ملف CSV',
		unsubscribe: 'إلغاء الاشتراك في هذا البريد',
		because: (org: string) => `تصلك هذه الرسالة لأنك عضو في ${org}.`,
		csvNote: 'رابط ملف CSV يعمل لمدة يومين.',
		cut: (n: number) => `يعرض أول ${n} صفًا. نزّل ملف CSV لبقية الصفوف.`,
		noData: 'لا توجد بيانات لهذه الفترة.',
		same: 'بلا تغيير',
		up: (p: string) => `ارتفاع ${p}`,
		down: (p: string) => `انخفاض ${p}`,
		estimate: 'تقدير',
		notSwitchedOn: 'غير مفعّل بعد',
	},
} as const

export function emailCopy(locale: EmailLocale) {
	return COPY[locale] ?? COPY.en
}

/** One figure entry as text: money with its currency code, ratings with two decimals. */
export function formatFigureEntry(
	entry: FigureEntry,
	format: FigureFormat,
	locale: EmailLocale,
): string {
	if (format === 'currency' && entry.currency) {
		try {
			return new Intl.NumberFormat(locale, {
				style: 'currency',
				currency: entry.currency,
			}).format(entry.value)
		} catch {
			return `${entry.value.toFixed(2)} ${entry.currency}`
		}
	}
	if (format === 'percent') {
		return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(entry.value)}%`
	}
	if (format === 'rating') {
		return new Intl.NumberFormat(locale, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(entry.value)
	}
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
		entry.value,
	)
}

export function changeText(
	entry: FigureEntry,
	previous: readonly FigureEntry[],
	locale: EmailLocale,
): string | null {
	const pct = figureChangePercent(entry, previous)
	if (pct === null) return null
	const copy = emailCopy(locale)
	const rounded = Math.round(Math.abs(pct) * 10) / 10
	if (rounded === 0) return copy.same
	const text = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rounded)}%`
	return pct > 0 ? copy.up(text) : copy.down(text)
}

export type SummaryLine = {
	label: string
	/** One formatted value per currency (or one value). */
	values: string[]
	/** The change, per value, or null. */
	changes: Array<string | null>
	/** A short qualifier shown after the label (for example "Estimate"). */
	tag?: string | null
}

export type SummaryEmailInput = {
	locale: EmailLocale
	organizationName: string
	title: string
	/** For example the day or the month the figures are for. */
	subtitle: string
	/** "vs same weekday last week" / "vs last month". */
	compareLabel: string
	lines: SummaryLine[]
	/** Quiet notes under the figures (for example "Not switched on yet: Reservations"). */
	notes?: string[]
	reportUrl: string
	csvUrl?: string | null
	unsubscribeUrl?: string | null
}

export type RenderedEmail = { subject: string; html: string; text: string }

const BASE =
	'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;'

function wrap(locale: EmailLocale, title: string, body: string) {
	const dir = locale === 'ar' ? 'rtl' : 'ltr'
	return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeXml(title)}</title></head><body style="margin:0;padding:24px;background:#f6f6f4;${BASE}"><div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">${body}</div></body></html>`
}

function footer(
	locale: EmailLocale,
	organizationName: string,
	unsubscribeUrl?: string | null,
) {
	const copy = emailCopy(locale)
	return `<p style="color:#6b6b6b;font-size:12px;margin:24px 0 0;">${escapeXml(copy.because(organizationName))}${
		unsubscribeUrl
			? ` <a href="${escapeXml(unsubscribeUrl)}" style="color:#6b6b6b;">${escapeXml(copy.unsubscribe)}</a>`
			: ''
	}</p>`
}

function links(locale: EmailLocale, reportUrl: string, csvUrl?: string | null) {
	const copy = emailCopy(locale)
	const a = (href: string, text: string) =>
		`<a href="${escapeXml(href)}" style="display:inline-block;margin-inline-end:12px;color:#0b57d0;">${escapeXml(text)}</a>`
	return `<p style="margin:20px 0 0;">${a(reportUrl, copy.openReport)}${
		csvUrl ? a(csvUrl, copy.downloadCsv) : ''
	}</p>${csvUrl ? `<p style="color:#6b6b6b;font-size:12px;margin:4px 0 0;">${escapeXml(copy.csvNote)}</p>` : ''}`
}

export function renderSummaryEmail(input: SummaryEmailInput): RenderedEmail {
	const copy = emailCopy(input.locale)
	const rows = input.lines
		.map((line) => {
			const values = line.values
				.map((value, index) => {
					const change = line.changes[index]
					return `<div>${escapeXml(value)}${
						change
							? ` <span style="color:#6b6b6b;font-size:12px;">${escapeXml(change)}</span>`
							: ''
					}</div>`
				})
				.join('')
			return `<tr><td style="padding:8px 0;border-top:1px solid #ececec;">${escapeXml(line.label)}${
				line.tag
					? ` <span style="color:#6b6b6b;font-size:12px;">(${escapeXml(line.tag)})</span>`
					: ''
			}</td><td style="padding:8px 0;border-top:1px solid #ececec;text-align:end;font-variant-numeric:tabular-nums;">${values}</td></tr>`
		})
		.join('')
	const notes = (input.notes ?? [])
		.map(
			(note) =>
				`<p style="color:#6b6b6b;font-size:13px;margin:8px 0 0;">${escapeXml(note)}</p>`,
		)
		.join('')
	const body = `<h1 style="font-size:20px;margin:0 0 4px;">${escapeXml(input.title)}</h1><p style="color:#6b6b6b;margin:0 0 16px;">${escapeXml(input.organizationName)} · ${escapeXml(input.subtitle)} · ${escapeXml(input.compareLabel)}</p><table role="presentation" style="width:100%;border-collapse:collapse;">${rows}</table>${notes}${links(input.locale, input.reportUrl, input.csvUrl)}${footer(input.locale, input.organizationName, input.unsubscribeUrl)}`
	const text = [
		`${input.title} · ${input.organizationName} · ${input.subtitle}`,
		input.compareLabel,
		'',
		...input.lines.map((line) => {
			const parts = line.values.map((value, index) => {
				const change = line.changes[index]
				return change ? `${value} (${change})` : value
			})
			return `${line.label}${line.tag ? ` (${line.tag})` : ''}: ${parts.join(' / ')}`
		}),
		...(input.notes ?? []),
		'',
		`${copy.openReport}: ${input.reportUrl}`,
		...(input.csvUrl ? [`${copy.downloadCsv}: ${input.csvUrl}`] : []),
		'',
		copy.because(input.organizationName),
		...(input.unsubscribeUrl
			? [`${copy.unsubscribe}: ${input.unsubscribeUrl}`]
			: []),
	].join('\n')
	return {
		subject: `${input.title}: ${input.organizationName}, ${input.subtitle}`,
		html: wrap(input.locale, input.title, body),
		text,
	}
}

export type TableEmailInput = {
	locale: EmailLocale
	organizationName: string
	title: string
	subtitle?: string | null
	/** Header first, as `reportToRows` gives them. */
	rows: string[][]
	maxRows?: number
	reportUrl: string
	csvUrl?: string | null
	unsubscribeUrl?: string | null
}

export const EMAIL_TABLE_MAX_ROWS = 25

export function renderTableEmail(input: TableEmailInput): RenderedEmail {
	const copy = emailCopy(input.locale)
	const max = input.maxRows ?? EMAIL_TABLE_MAX_ROWS
	const [header, ...data] = input.rows
	const shown = data.slice(0, max)
	const cut = data.length > shown.length
	const cell = (tag: 'th' | 'td', value: string) =>
		`<${tag} style="padding:6px 8px;border-top:1px solid #ececec;text-align:start;">${escapeXml(value)}</${tag}>`
	const table =
		header && data.length > 0
			? `<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>${header.map((h) => cell('th', h)).join('')}</tr></thead><tbody>${shown
					.map((row) => `<tr>${row.map((v) => cell('td', v)).join('')}</tr>`)
					.join('')}</tbody></table>`
			: `<p>${escapeXml(copy.noData)}</p>`
	const body = `<h1 style="font-size:20px;margin:0 0 4px;">${escapeXml(input.title)}</h1><p style="color:#6b6b6b;margin:0 0 16px;">${escapeXml(input.organizationName)}${input.subtitle ? ` · ${escapeXml(input.subtitle)}` : ''}</p>${table}${
		cut
			? `<p style="color:#6b6b6b;font-size:13px;">${escapeXml(copy.cut(max))}</p>`
			: ''
	}${links(input.locale, input.reportUrl, input.csvUrl)}${footer(input.locale, input.organizationName, input.unsubscribeUrl)}`
	const text = [
		`${input.title} · ${input.organizationName}`,
		'',
		...(header && data.length > 0
			? [header.join(' | '), ...shown.map((row) => row.join(' | '))]
			: [copy.noData]),
		...(cut ? [copy.cut(max)] : []),
		'',
		`${copy.openReport}: ${input.reportUrl}`,
		...(input.csvUrl ? [`${copy.downloadCsv}: ${input.csvUrl}`] : []),
		'',
		copy.because(input.organizationName),
		...(input.unsubscribeUrl
			? [`${copy.unsubscribe}: ${input.unsubscribeUrl}`]
			: []),
	].join('\n')
	return {
		subject: `${input.title}: ${input.organizationName}`,
		html: wrap(input.locale, input.title, body),
		text,
	}
}

/** The figure lines of a summary, formatted for a recipient (hidden figures already left out). */
export function summaryLines(
	values: readonly FigureValue[],
	labels: Readonly<Record<string, string>>,
	locale: EmailLocale,
): SummaryLine[] {
	return values.map((value) => {
		const entries =
			value.entries.length > 0
				? value.entries
				: [{ currency: null, value: 0 } as FigureEntry]
		return {
			label: labels[value.id] ?? value.id,
			values: entries.map((entry) =>
				formatFigureEntry(entry, value.format, locale),
			),
			changes: entries.map((entry) =>
				changeText(entry, value.previous, locale),
			),
		}
	})
}

const FIGURE_LABELS_AR: Record<FigureId, string> = {
	netSales: 'صافي المبيعات',
	orders: 'الطلبات',
	averageSale: 'متوسط البيع',
	tips: 'الإكراميات',
	refunds: 'المبالغ المستردة',
	laborCost: 'تكلفة العمالة',
	laborPercent: 'نسبة تكلفة العمالة',
	covers: 'عدد الضيوف',
	newReviews: 'تقييمات جديدة',
	averageRating: 'متوسط التقييم',
	directSales: 'المبيعات المباشرة',
	directOrders: 'الطلبات المباشرة',
	onlineSales: 'المبيعات المباشرة عبر الإنترنت',
	newGuestOrders: 'طلبات من ضيوف جدد',
	returningGuestOrders: 'طلبات من ضيوف عائدين',
	bookings: 'حجوزات الطاولات',
	callsAnswered: 'مكالمات أجاب عنها وكيل الهاتف',
	callsHandled: 'مكالمات عولجت دون موظف',
	attributedSales: 'مبيعات من رسائلك الإلكترونية والنصية',
	attributedOrders: 'طلبات من رسائلك الإلكترونية والنصية',
	loyaltyRewards: 'مكافآت الولاء المستخدمة',
}

/** A figure's name in the recipient's language. */
export function figureLabel(id: FigureId, locale: EmailLocale): string {
	return locale === 'ar' ? FIGURE_LABELS_AR[id] : FIGURES[id].label
}

export function figureLabels(locale: EmailLocale): Record<FigureId, string> {
	return Object.fromEntries(
		(Object.keys(FIGURES) as FigureId[]).map((id) => [
			id,
			figureLabel(id, locale),
		]),
	) as Record<FigureId, string>
}
