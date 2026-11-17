import { type ReportField, type ReportSubject } from './catalog.ts'

export const MENU_INSIGHTS_REPORT_SUBJECTS = [
	'item_pairs',
	'modifier_sales',
	'sold_out_history',
] as const
export type MenuInsightsReportSubject =
	(typeof MENU_INSIGHTS_REPORT_SUBJECTS)[number]

export function isMenuInsightsReportSubject(
	subject: string,
): subject is MenuInsightsReportSubject {
	return MENU_INSIGHTS_REPORT_SUBJECTS.some((item) => item === subject)
}

const locationField: ReportField = {
	id: 'locationId',
	label: 'Location',
	type: 'string',
	filterable: true,
	groupable: true,
}

const channelField: ReportField = {
	id: 'channel',
	label: 'Channel',
	type: 'enum',
	filterable: true,
	groupable: true,
	options: [
		{ value: 'online_menu', label: 'Online menu' },
		{ value: 'drop', label: 'Drop' },
		{ value: 'qr_table', label: 'QR table' },
		{ value: 'qr_poster', label: 'QR poster' },
		{ value: 'station_counter', label: 'Station counter' },
		{ value: 'station_phone', label: 'Station phone order' },
	],
}

const itemPairFields: ReportField[] = [
	{
		id: 'occurredAt',
		label: 'Date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	locationField,
	channelField,
	{
		id: 'itemAId',
		label: 'Item A',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'itemBId',
		label: 'Item B',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'itemAName',
		label: 'Item A name',
		type: 'string',
		groupable: true,
	},
	{
		id: 'itemBName',
		label: 'Item B name',
		type: 'string',
		groupable: true,
	},
	{
		id: 'pairIncluded',
		label: 'Orders with pair',
		type: 'number',
		sumLabel: 'Orders',
		description: 'One per order that contained this pair of items.',
	},
	{
		id: 'pairShare',
		label: 'Share of orders',
		type: 'ratio',
		ratio: {
			numerator: 'pairIncluded',
			denominator: 'ordersWithPairs',
			unit: 'percent',
		},
		description:
			'This pair count divided by orders that had at least two items.',
	},
	{
		id: 'ordersWithPairs',
		label: 'Orders with pairs',
		type: 'number',
		listable: false,
		sumLabel: 'Orders with two or more items',
	},
]

const modifierSalesFields: ReportField[] = [
	{
		id: 'occurredAt',
		label: 'Date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	locationField,
	channelField,
	{
		id: 'parentItemId',
		label: 'Item',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'parentItemName',
		label: 'Item name',
		type: 'string',
		groupable: true,
	},
	{
		id: 'optionId',
		label: 'Option',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'optionName',
		label: 'Option name',
		type: 'string',
		groupable: true,
	},
	{
		id: 'attachCount',
		label: 'Attach count',
		type: 'number',
		sumLabel: 'Times attached',
	},
	{
		id: 'parentItemCount',
		label: 'Item orders',
		type: 'number',
		sumLabel: 'Item orders',
	},
	{
		id: 'attachRate',
		label: 'Attach rate',
		type: 'ratio',
		ratio: {
			numerator: 'attachCount',
			denominator: 'parentItemCount',
			unit: 'percent',
		},
	},
	{
		id: 'sales',
		label: 'Option sales',
		type: 'currency',
		sumLabel: 'Option sales',
		description: 'Option charges before tax, after discounts on the line.',
	},
]

const soldOutFields: ReportField[] = [
	{
		id: 'startedAt',
		label: 'Started',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
	},
	{
		id: 'endedAt',
		label: 'Ended',
		type: 'datetime',
		showTime: true,
	},
	locationField,
	{
		id: 'location',
		label: 'Location name',
		type: 'string',
		groupable: true,
	},
	{
		id: 'entityType',
		label: 'Entity type',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'item', label: 'Dish' },
			{ value: 'modifier_option', label: 'Option' },
		],
	},
	{
		id: 'entityId',
		label: 'Dish or option id',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'source',
		label: 'Source',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'automatic', label: 'Automatic (stock)' },
			{ value: 'manual', label: 'Manual' },
		],
	},
	{
		id: 'durationMinutes',
		label: 'Minutes unavailable',
		type: 'number',
		sumLabel: 'Total minutes',
		averageLabel: 'Average minutes',
	},
	{
		id: 'lostSalesEstimate',
		label: 'Lost sales (estimate)',
		type: 'currency',
		sumLabel: 'Estimated lost sales',
		description:
			'An estimate from recent item sales rate, never counted as revenue.',
	},
]

export const menuInsightsReportSubjects: ReportSubject[] = [
	{
		id: 'item_pairs',
		label: 'Item pairs',
		description:
			'Dishes ordered together in the same sale, counted once per order per pair.',
		scope: 'organization',
		source: 'tenant-api',
		fields: itemPairFields,
		defaultColumns: [
			'itemAName',
			'itemBName',
			'pairIncluded',
			'pairShare',
			'channel',
			'locationId',
		],
	},
	{
		id: 'modifier_sales',
		label: 'Modifier sales',
		description:
			'How often each modifier is attached to its items, with option sales.',
		scope: 'organization',
		source: 'tenant-api',
		fields: modifierSalesFields,
		currencyField: 'currency',
		defaultColumns: [
			'optionName',
			'parentItemName',
			'attachRate',
			'attachCount',
			'sales',
		],
	},
	{
		id: 'sold_out_history',
		label: 'Sold-out history',
		description:
			'When dishes were unavailable, how long, and an estimated sales impact.',
		scope: 'organization',
		source: 'tenant-api',
		fields: soldOutFields,
		currencyField: 'currency',
		defaultColumns: [
			'entityId',
			'location',
			'source',
			'durationMinutes',
			'startedAt',
			'endedAt',
		],
	},
]
