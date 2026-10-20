import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ReportTemplate } from '../templates.ts'

/**
 * Translatable names for the staff report templates and their categories. The
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
}

const CATEGORY_LABELS: Record<string, ReturnType<typeof msg>> = {
	Labor: msg`Labor`,
	Hiring: msg`Hiring`,
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
