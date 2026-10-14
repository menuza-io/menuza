import { type ReportScope, getCatalog } from './catalog.ts'
import {
	type FilterCondition,
	type Measure,
	type ReportDefinition,
	createReportDefinition,
	emptyFilterGroup,
} from './dsl.ts'

export type ReportTemplate = {
	id: string
	category: string
	title: string
	description: string
	scope: ReportScope
	definition: ReportDefinition
}

function template(
	scope: ReportScope,
	input: Omit<ReportTemplate, 'scope' | 'definition'> & {
		subject: string
		groupBy: string[]
		chartStyle: ReportDefinition['visualization']['chartStyle']
		timeframePreset?: ReportDefinition['timeframe']['preset']
		timeframeField?: string
		timeBucket?: ReportDefinition['timeBucket']
		columns?: string[]
		sortBy?: ReportDefinition['visualization']['sortBy']
		measure?: Measure
		/** Number or currency field a sum or average reads. */
		valueField?: string
		/** Conditions that must all match. */
		filters?: FilterCondition[]
		title?: string
	},
): ReportTemplate {
	const catalog = getCatalog(scope)
	const subject = catalog.subjects.find((item) => item.id === input.subject)
	if (!subject) {
		throw new Error(`Unknown template subject: ${input.subject}`)
	}
	const timeframeField =
		input.timeframeField ??
		subject.fields.find((field) => field.timeframe)?.id ??
		'createdAt'

	return {
		id: input.id,
		category: input.category,
		title: input.title,
		description: input.description,
		scope,
		definition: createReportDefinition({
			subject: input.subject,
			timeframe: {
				field: timeframeField,
				preset: input.timeframePreset ?? 'last_3_months',
			},
			groupBy: input.groupBy,
			timeBucket: input.timeBucket ?? 'month',
			columns: input.columns ?? [],
			filters: input.filters?.length
				? { combinator: 'and', conditions: input.filters }
				: emptyFilterGroup(),
			visualization: {
				chartStyle: input.chartStyle,
				measure: input.measure ?? 'count',
				...(input.valueField ? { valueField: input.valueField } : {}),
				sortBy: input.sortBy ?? 'value_desc',
				hideCounts: false,
			},
			settings: {
				title: input.title,
				notes: input.description,
				timezone: 'user',
			},
		}),
	}
}

function customerTemplates(): ReportTemplate[] {
	const customers = { category: 'Customers', subject: 'customers' } as const
	return [
		template('organization', {
			...customers,
			id: 'customer-count',
			title: 'Customer count',
			description:
				'A single number of site customers in the selected timeframe.',
			groupBy: [],
			chartStyle: 'single_number',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			...customers,
			id: 'customers-by-month',
			title: 'Customers by month',
			description: 'Count new site customers over the last 3 months.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			sortBy: 'none',
		}),
		template('organization', {
			...customers,
			id: 'customers-by-week',
			title: 'Customers by week',
			description: 'Count new site customers week by week.',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'week',
			sortBy: 'none',
		}),
		template('organization', {
			...customers,
			id: 'customers-verified',
			title: 'Phone verification',
			description: 'Segment customers by whether their phone is verified.',
			groupBy: ['phoneVerified'],
			chartStyle: 'pie',
		}),
		template('organization', {
			...customers,
			id: 'customer-list',
			title: 'Customer list',
			description:
				'A table of site customers with name, email, phone, and created date.',
			groupBy: [],
			chartStyle: 'table',
			columns: ['name', 'email', 'phone', 'createdAt'],
			timeframePreset: 'all_time',
			sortBy: 'none',
		}),
	]
}

function marketingTemplates(): ReportTemplate[] {
	return [
		template('organization', {
			id: 'email-audience',
			category: 'Marketing',
			title: 'Email audience',
			description:
				'Customers with an email address, who your marketing emails can reach.',
			subject: 'customers',
			groupBy: [],
			chartStyle: 'single_number',
			filters: [{ field: 'hasEmail', operator: 'eq', value: 'true' }],
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'email-audience-share',
			category: 'Marketing',
			title: 'Customers with email',
			description: 'Share of customers your marketing emails can reach.',
			subject: 'customers',
			groupBy: ['hasEmail'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
	]
}

/**
 * Labor templates. Shares are always a ratio of sums over the days with sales
 * (see the ratio measure), money is never added across currencies, and wages
 * are estimates from pay rates. Reports on one person's pay need the pay
 * permission; the rest need timesheet, schedule or labor access.
 */
function laborTemplates(): ReportTemplate[] {
	return [
		template('organization', {
			id: 'labor-cost-percent',
			category: 'Labor',
			title: 'Labor cost percent',
			description:
				'Wages as a share of sales over the last 30 days: total wages divided by total sales across the days that have sales.',
			subject: 'labor_daily',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'ratio',
			valueField: 'laborCostPercent',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'labor-cost-percent-by-day',
			category: 'Labor',
			title: 'Labor cost percent by day',
			description:
				'Wages as a share of sales for each business day. The share for a longer range divides the totals; it is never an average of the daily percentages.',
			subject: 'labor_daily',
			groupBy: ['date'],
			chartStyle: 'bar',
			measure: 'ratio',
			valueField: 'laborCostPercent',
			timeBucket: 'day',
			timeframePreset: 'last_30_days',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'labor-cost-percent-by-workplace',
			category: 'Labor',
			title: 'Labor cost percent by workplace',
			description: 'Compare wages as a share of sales across your workplaces.',
			subject: 'labor_daily',
			groupBy: ['scope'],
			chartStyle: 'bar',
			measure: 'ratio',
			valueField: 'laborCostPercent',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'sales-per-labor-hour',
			category: 'Labor',
			title: 'Sales per labor hour',
			description:
				'Sales divided by the hours worked, day by day, on the days that have sales.',
			subject: 'labor_daily',
			groupBy: ['date'],
			chartStyle: 'bar',
			measure: 'ratio',
			valueField: 'salesPerLaborHour',
			timeBucket: 'day',
			timeframePreset: 'last_30_days',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'hours-by-employee',
			category: 'Labor',
			title: 'Hours by employee',
			description: 'Paid hours worked by each person over the last 30 days.',
			subject: 'time_entries',
			groupBy: ['employee'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'paidMinutes',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'hours-by-day',
			category: 'Labor',
			title: 'Hours worked by day',
			description: 'Paid hours worked each day across your team.',
			subject: 'time_entries',
			groupBy: ['clockInAt'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'paidMinutes',
			timeBucket: 'day',
			timeframePreset: 'last_30_days',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'overtime-hours-by-week',
			category: 'Labor',
			title: 'Overtime hours by week',
			description:
				'Overtime and double time worked each week, from each workplace’s labor rules.',
			subject: 'time_entries',
			groupBy: ['clockInAt'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'overtimeMinutes',
			timeBucket: 'week',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'overtime-hours-by-employee',
			category: 'Labor',
			title: 'Overtime hours by employee',
			description: 'Who worked overtime over the last 30 days, and how much.',
			subject: 'time_entries',
			groupBy: ['employee'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'overtimeMinutes',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'scheduled-vs-actual-hours',
			category: 'Labor',
			title: 'Scheduled vs actual hours and clock-ins',
			description:
				'Each day’s published hours and shifts next to the hours worked and the time cards that started, with the difference.',
			subject: 'labor_daily',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'date',
				'scope',
				'scheduledMinutes',
				'paidMinutes',
				'varianceMinutes',
				'shifts',
				'clockIns',
			],
			timeframePreset: 'last_7_days',
		}),
		template('organization', {
			id: 'on-time-arrival',
			category: 'Labor',
			title: 'On-time arrival',
			description:
				'How often people clock in on time for the shifts they were scheduled on.',
			subject: 'time_entries',
			groupBy: ['arrival'],
			chartStyle: 'pie',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'late-arrivals-by-employee',
			category: 'Labor',
			title: 'Late arrivals by employee',
			description:
				'People who clocked in late for a scheduled shift, and how often.',
			subject: 'time_entries',
			groupBy: ['employee'],
			chartStyle: 'bar',
			filters: [{ field: 'arrival', operator: 'eq', value: 'late' }],
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'labor-by-position',
			category: 'Labor',
			title: 'Labor by position',
			description:
				'Estimated wages by position over the last 30 days. Needs permission to see pay.',
			subject: 'time_entries',
			groupBy: ['position'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'cost',
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'tip-pool',
			category: 'Labor',
			title: 'Tip pool: tips by day',
			description:
				'Tips on online orders that count toward sales, by business day. How a pool is split between people is set on the Labor page.',
			subject: 'labor_daily',
			groupBy: ['date'],
			chartStyle: 'bar',
			measure: 'sum',
			valueField: 'tips',
			timeBucket: 'day',
			timeframePreset: 'last_30_days',
			sortBy: 'none',
		}),
	]
}

function hiringTemplates(): ReportTemplate[] {
	return [
		template('organization', {
			id: 'applicant-funnel',
			category: 'Hiring',
			title: 'Applicant funnel',
			description:
				'Applications at each stage, from new to hired, over the last 3 months.',
			subject: 'applications',
			groupBy: ['stage'],
			chartStyle: 'bar',
		}),
		template('organization', {
			id: 'applications-by-source',
			category: 'Hiring',
			title: 'Applications by source',
			description: 'Where applicants found the job.',
			subject: 'applications',
			groupBy: ['source'],
			chartStyle: 'pie',
		}),
	]
}

export function organizationTemplates(): ReportTemplate[] {
	return [
		...customerTemplates(),
		...marketingTemplates(),
		...laborTemplates(),
		...hiringTemplates(),
		template('organization', {
			id: 'phone-calls-by-week',
			category: 'Phone calls',
			title: 'Calls by week',
			description: 'Count calls answered by the phone agent week by week.',
			subject: 'phone_calls',
			groupBy: ['startedAt'],
			chartStyle: 'bar',
			timeBucket: 'week',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'phone-calls-by-purpose',
			category: 'Phone calls',
			title: 'Why people call',
			description: 'Calls grouped by why the caller rang.',
			subject: 'phone_calls',
			groupBy: ['purpose'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-by-outcome',
			category: 'Phone calls',
			title: 'Call outcomes',
			description:
				'How calls ended: resolved, link sent, transferred, message, or hung up.',
			subject: 'phone_calls',
			groupBy: ['outcome'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-resolved',
			category: 'Phone calls',
			title: 'Handled without staff',
			description:
				'Share of calls the assistant handled with no transfer or message.',
			subject: 'phone_calls',
			groupBy: ['resolvedByAssistant'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-transfers',
			category: 'Phone calls',
			title: 'Transfers',
			description: 'Transferred calls split by whether staff picked up.',
			subject: 'phone_calls',
			groupBy: ['transferResult'],
			chartStyle: 'bar',
		}),
		template('organization', {
			id: 'phone-calls-open-closed',
			category: 'Phone calls',
			title: 'Calls while open vs closed',
			description: 'How many calls come in outside business hours.',
			subject: 'phone_calls',
			groupBy: ['calledWhileOpen'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-length',
			category: 'Phone calls',
			title: 'Call length',
			description: 'Calls grouped by how long they lasted.',
			subject: 'phone_calls',
			groupBy: ['durationBucket'],
			chartStyle: 'bar',
			sortBy: 'label',
		}),
		template('organization', {
			id: 'phone-calls-repeat',
			category: 'Phone calls',
			title: 'Repeat callers',
			description: 'Calls from numbers that called in the previous 30 days.',
			subject: 'phone_calls',
			groupBy: ['repeatCaller'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-links',
			category: 'Phone calls',
			title: 'Links texted',
			description: 'Calls where the caller got a link by text.',
			subject: 'phone_calls',
			groupBy: ['linkSent'],
			chartStyle: 'pie',
		}),
		template('organization', {
			id: 'phone-calls-ratings',
			category: 'Phone calls',
			title: 'Caller ratings',
			description: 'End-of-call ratings from 1 to 5.',
			subject: 'phone_calls',
			groupBy: ['rating'],
			chartStyle: 'bar',
			sortBy: 'label',
		}),
		template('organization', {
			id: 'phone-calls-follow-up',
			category: 'Phone calls',
			title: 'Calls needing follow-up',
			description: 'A list of calls that still need someone on the team.',
			subject: 'phone_calls',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'startedAt',
				'callerPhone',
				'purpose',
				'outcome',
				'followUpStatus',
			],
			timeframePreset: 'all_time',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'shop-sales',
			category: 'Shop',
			title: 'Shop sales',
			description: 'Paid purchases from your public site shop.',
			subject: 'shop_orders',
			groupBy: [],
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'amount',
			filters: [{ field: 'status', operator: 'eq', value: 'paid' }],
			timeframePreset: 'last_30_days',
		}),
		template('organization', {
			id: 'shop-orders-by-month',
			category: 'Shop',
			title: 'Orders by month',
			description: 'Count shop orders over the last 3 months.',
			subject: 'shop_orders',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'shop-orders-by-status',
			category: 'Shop',
			title: 'Orders by status',
			description: 'See how shop orders are distributed by payment status.',
			subject: 'shop_orders',
			groupBy: ['status'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'shop-order-list',
			category: 'Shop',
			title: 'Order list',
			description:
				'A table of shop orders with customer, product, amount, status, and date.',
			subject: 'shop_orders',
			groupBy: [],
			chartStyle: 'table',
			columns: [
				'customerName',
				'customerPhone',
				'productName',
				'amount',
				'status',
				'createdAt',
			],
			timeframePreset: 'all_time',
			sortBy: 'none',
		}),
		template('organization', {
			id: 'shop-order-count',
			category: 'Shop',
			title: 'Order count',
			description: 'A single number of shop orders in the selected timeframe.',
			subject: 'shop_orders',
			groupBy: [],
			chartStyle: 'single_number',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'notes-by-status',
			category: 'Notes',
			title: 'Notes by status',
			description: 'See how notes are distributed across board columns.',
			subject: 'notes',
			groupBy: ['status'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'notes-by-priority',
			category: 'Notes',
			title: 'Notes by priority',
			description: 'Count notes grouped by priority.',
			subject: 'notes',
			groupBy: ['priority'],
			chartStyle: 'bar',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'members-by-role',
			category: 'Team',
			title: 'Members by role',
			description: 'Count operators in this organization by role.',
			subject: 'members',
			groupBy: ['role'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('organization', {
			id: 'feedback-by-type',
			category: 'Feedback',
			title: 'Feedback by type',
			description: 'Count in-app feedback submissions by type.',
			subject: 'feedback',
			groupBy: ['type'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
	]
}

export function platformTemplates(): ReportTemplate[] {
	return [
		template('platform', {
			id: 'orgs-by-region',
			category: 'Organizations',
			title: 'Organizations by region',
			description: 'Count tenants by customer data region.',
			subject: 'organizations',
			groupBy: ['dataRegion'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('platform', {
			id: 'orgs-published',
			category: 'Organizations',
			title: 'Published sites',
			description: 'How many organizations have published a public site.',
			subject: 'organizations',
			groupBy: ['sitePublished'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('platform', {
			id: 'users-by-month',
			category: 'Users',
			title: 'New operators by month',
			description: 'Count operator signups over the last 6 months.',
			subject: 'users',
			groupBy: ['createdAt'],
			chartStyle: 'bar',
			timeBucket: 'month',
			timeframePreset: 'last_6_months',
			sortBy: 'none',
		}),
		template('platform', {
			id: 'waitlist-access',
			category: 'Waitlist',
			title: 'Waitlist early access',
			description: 'Segment waitlist entries by early-access grant.',
			subject: 'waitlist',
			groupBy: ['hasEarlyAccess'],
			chartStyle: 'pie',
			timeframePreset: 'all_time',
		}),
		template('platform', {
			id: 'feedback-types',
			category: 'Feedback',
			title: 'Platform feedback',
			description: 'Count feedback across every organization by type.',
			subject: 'feedback',
			groupBy: ['type'],
			chartStyle: 'pie',
		}),
		template('platform', {
			id: 'audit-severity',
			category: 'Security',
			title: 'Audit log severity',
			description: 'Count audit events by severity.',
			subject: 'audit_logs',
			groupBy: ['severity'],
			chartStyle: 'bar',
			timeframePreset: 'last_30_days',
		}),
		template('platform', {
			id: 'user-count',
			category: 'Users',
			title: 'Operator count',
			description: 'Total operator accounts created in the selected timeframe.',
			subject: 'users',
			groupBy: [],
			chartStyle: 'single_number',
			timeframePreset: 'all_time',
		}),
	]
}

export function templatesFor(scope: ReportScope): ReportTemplate[] {
	return scope === 'platform' ? platformTemplates() : organizationTemplates()
}

export function blankReportDefinition(scope: ReportScope): ReportDefinition {
	if (scope === 'platform') {
		return createReportDefinition({
			subject: 'organizations',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			groupBy: ['dataRegion'],
			timeBucket: 'month',
			columns: [],
			filters: emptyFilterGroup(),
			visualization: {
				chartStyle: 'pie',
				measure: 'count',
				sortBy: 'value_desc',
				hideCounts: false,
			},
			settings: {
				title: 'New Report',
				notes: '',
				timezone: 'user',
			},
		})
	}

	return createReportDefinition({
		subject: 'customers',
		timeframe: { field: 'createdAt', preset: 'last_3_months' },
		groupBy: [],
		timeBucket: 'month',
		columns: [],
		filters: emptyFilterGroup(),
		visualization: {
			chartStyle: 'pie',
			measure: 'count',
			sortBy: 'value_desc',
			hideCounts: false,
		},
		settings: {
			title: 'New Report',
			notes: '',
			timezone: 'user',
		},
	})
}

export function definitionForNewReport(
	scope: ReportScope,
	templateId: string | null | undefined,
): ReportDefinition {
	const template = templateId
		? templatesFor(scope).find((item) => item.id === templateId)
		: undefined
	return template?.definition ?? blankReportDefinition(scope)
}

export function templateCategories(templates: ReportTemplate[]): string[] {
	return [...new Set(templates.map((item) => item.category))]
}
