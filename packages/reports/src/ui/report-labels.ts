import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ReportTemplate } from '../templates.ts'

/**
 * Translatable names for the staff and Reservations report templates and their categories. The
 * template data itself stays plain English (it is also the saved report's
 * default title and the engine's input); the Reports screens look the
 * translation up by template id and fall back to the English text. Strings are
 * extracted from this package by the apps' Lingui configs.
 */

type TemplateLabel = {
	title: ReturnType<typeof msg>
	description: ReturnType<typeof msg>
}

const TEMPLATE_LABELS: Record<string, TemplateLabel> = {
	'labor-cost-percent': {
		title: msg`Labor cost percent`,
		description: msg`Wages as a share of sales over the last 30 days: total wages divided by total sales across the days that have sales.`,
	},
	'labor-cost-percent-by-day': {
		title: msg`Labor cost percent by day`,
		description: msg`Wages as a share of sales for each business day. The share for a longer range divides the totals; it is never an average of the daily percentages.`,
	},
	'labor-cost-percent-by-workplace': {
		title: msg`Labor cost percent by workplace`,
		description: msg`Compare wages as a share of sales across your workplaces.`,
	},
	'sales-per-labor-hour': {
		title: msg`Sales per labor hour`,
		description: msg`Sales divided by the hours worked, day by day, on the days that have sales.`,
	},
	'hours-by-employee': {
		title: msg`Hours by employee`,
		description: msg`Paid hours worked by each person over the last 30 days.`,
	},
	'hours-by-day': {
		title: msg`Hours worked by day`,
		description: msg`Paid hours worked each day across your team.`,
	},
	'overtime-hours-by-week': {
		title: msg`Overtime hours by week`,
		description: msg`Overtime and double time worked each week, from each workplace’s labor rules.`,
	},
	'overtime-hours-by-employee': {
		title: msg`Overtime hours by employee`,
		description: msg`Who worked overtime over the last 30 days, and how much.`,
	},
	'scheduled-vs-actual-hours': {
		title: msg`Scheduled vs actual hours and clock-ins`,
		description: msg`Each day’s published hours and shifts next to the hours worked and the time cards that started, with the difference.`,
	},
	'on-time-arrival': {
		title: msg`On-time arrival`,
		description: msg`How often people clock in on time for the shifts they were scheduled on.`,
	},
	'late-arrivals-by-employee': {
		title: msg`Late arrivals by employee`,
		description: msg`People who clocked in late for a scheduled shift, and how often.`,
	},
	'labor-by-position': {
		title: msg`Labor by position`,
		description: msg`Estimated wages by position over the last 30 days. Needs permission to see pay.`,
	},
	'tip-pool': {
		title: msg`Tip pool: tips by day`,
		description: msg`Tips on online orders that count toward sales, by business day. How a pool is split between people is set on the Labor page.`,
	},
	'applicant-funnel': {
		title: msg`Applicant funnel`,
		description: msg`Applications at each stage, from new to hired, over the last 3 months.`,
	},
	'applications-by-source': {
		title: msg`Applications by source`,
		description: msg`Where applicants found the job.`,
	},
	'rsv-daily-summary': {
		title: msg`Daily summary`,
		description: msg`Covers booked for each service day over the last 7 days, not counting cancelled, declined or expired bookings.`,
	},
	'rsv-covers-by-service': {
		title: msg`Covers by service`,
		description: msg`Covers booked for each service over the last 30 days, not counting cancelled, declined or expired bookings.`,
	},
	'rsv-booking-sources': {
		title: msg`Booking sources`,
		description: msg`Where bookings come from over the last 30 days: online, phone, host, walk-in and more.`,
	},
	'rsv-no-show-rate': {
		title: msg`No-shows & cancellations`,
		description: msg`The share of booked parties that did not show up, for each service over the last 30 days. Cancelled, declined and expired bookings are not counted as booked.`,
	},
	'rsv-cancellations-by-who': {
		title: msg`Cancellations by who`,
		description: msg`Who cancelled over the last 30 days: the guest, the restaurant or the system.`,
	},
	'rsv-late-cancellations': {
		title: msg`Late cancellations`,
		description: msg`The share of cancellations that came after the free-cancellation window closed, for each service over the last 30 days.`,
	},
	'rsv-no-show-list': {
		title: msg`No-show list`,
		description: msg`Every no-show over the last 30 days with its date, service, party size and source. No guest details.`,
	},
	'rsv-turn-times': {
		title: msg`Turn times`,
		description: msg`How long parties of each size stayed, from seated to finished, over the last 30 days.`,
	},
	'rsv-turn-time-variance': {
		title: msg`Turn times against target`,
		description: msg`How far actual turn times ran from the turn time you set, for each party size over the last 30 days. Negative means parties left early.`,
	},
	'rsv-waitlist-outcomes': {
		title: msg`Waitlist outcomes`,
		description: msg`How waitlist parties ended up over the last 30 days: seated, left, cancelled or no response.`,
	},
	'rsv-waitlist-waits': {
		title: msg`Waitlist waits`,
		description: msg`The wait you quoted and the wait parties had before they were seated, by party size, over the last 30 days.`,
	},
	'rsv-pacing': {
		title: msg`Pacing`,
		description: msg`Covers in each start time against the pacing limit over the last 7 days, and how many slots went over it.`,
	},
	'rsv-covers-today': {
		title: msg`Covers today`,
		description: msg`Covers booked for today, not counting cancelled, declined or expired bookings.`,
	},
	'rsv-no-show-rate-30d': {
		title: msg`No-show rate, last 30 days`,
		description: msg`The share of booked parties that did not show up over the last 30 days.`,
	},
	'rsv-late-cancels-30d': {
		title: msg`Late cancellations, last 30 days`,
		description: msg`Bookings cancelled after the free-cancellation window over the last 30 days.`,
	},
	'rsv-waitlist-avg-wait-7d': {
		title: msg`Average waitlist wait, last 7 days`,
		description: msg`How long waitlist parties waited before they were seated over the last 7 days.`,
	},
}

const CATEGORY_LABELS: Record<string, ReturnType<typeof msg>> = {
	Labor: msg`Labor`,
	Hiring: msg`Hiring`,
	Reservations: msg`Reservations`,
}

export function useReportLabels() {
	const { _ } = useLingui()
	return {
		templateTitle: (template: Pick<ReportTemplate, 'id' | 'title'>) => {
			const label = TEMPLATE_LABELS[template.id]
			return label ? _(label.title) : template.title
		},
		templateDescription: (
			template: Pick<ReportTemplate, 'id' | 'description'>,
		) => {
			const label = TEMPLATE_LABELS[template.id]
			return label ? _(label.description) : template.description
		},
		categoryLabel: (category: string) => {
			const label = CATEGORY_LABELS[category]
			return label ? _(label) : category
		},
	}
}

/** Template ids that have a translation, for tests. */
export const TRANSLATED_TEMPLATE_IDS = Object.keys(TEMPLATE_LABELS)
