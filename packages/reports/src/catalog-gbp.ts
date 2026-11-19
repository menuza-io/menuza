import { type ReportField, type ReportSubject } from './catalog.ts'

export const GBP_REPORT_SUBJECTS = [
	'gbp_performance',
	'gbp_search_keywords',
] as const

export type GbpReportSubject = (typeof GBP_REPORT_SUBJECTS)[number]

export function isGbpReportSubject(
	subject: string,
): subject is GbpReportSubject {
	return GBP_REPORT_SUBJECTS.some((item) => item === subject)
}

const gbpPerformanceFields: ReportField[] = [
	{
		id: 'day',
		label: 'Date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'location',
		label: 'Location',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'locationId',
		label: 'Location ID',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'views',
		label: 'Total views',
		type: 'number',
		sumLabel: 'Views',
		description: 'Google Search and Google Maps impressions combined.',
	},
	{
		id: 'searchViews',
		label: 'Search views',
		type: 'number',
		sumLabel: 'Search views',
	},
	{
		id: 'mapsViews',
		label: 'Maps views',
		type: 'number',
		sumLabel: 'Maps views',
	},
	{
		id: 'calls',
		label: 'Calls',
		type: 'number',
		sumLabel: 'Calls',
	},
	{
		id: 'websiteClicks',
		label: 'Website clicks',
		type: 'number',
		sumLabel: 'Website clicks',
	},
	{
		id: 'directionRequests',
		label: 'Direction requests',
		type: 'number',
		sumLabel: 'Directions',
	},
	{
		id: 'foodOrders',
		label: 'Order clicks',
		type: 'number',
		sumLabel: 'Order clicks',
	},
	{
		id: 'bookings',
		label: 'Booking clicks',
		type: 'number',
		sumLabel: 'Bookings',
	},
]

const gbpSearchKeywordFields: ReportField[] = [
	{
		id: 'month',
		label: 'Month',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'location',
		label: 'Location',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'locationId',
		label: 'Location ID',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'keyword',
		label: 'Search term',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'impressions',
		label: 'Impressions',
		type: 'number',
		sumLabel: 'Impressions',
		description:
			'Exact impressions from Google; blank when Google reports a threshold such as "< 15".',
	},
	{
		id: 'impressionsDisplay',
		label: 'Shown count',
		type: 'string',
		filterable: true,
		description: 'Exact count or Google threshold range (e.g. "< 15").',
	},
]

export const gbpReportSubjects: ReportSubject[] = [
	{
		id: 'gbp_performance',
		label: 'Google listing performance',
		description:
			'Daily views, calls, website clicks, directions, order clicks, and bookings from Google Business Profile.',
		scope: 'organization',
		source: 'control-plane',
		fields: gbpPerformanceFields,
	},
	{
		id: 'gbp_search_keywords',
		label: 'Google search terms',
		description:
			'Monthly search queries that showed your Google Business Profile.',
		scope: 'organization',
		source: 'control-plane',
		fields: gbpSearchKeywordFields,
	},
]
