import { type ReportField, type ReportSubject } from './catalog.ts'

export const MENU_INSIGHTS_REPORT_SUBJECTS = [
	'item_pairs',
	'modifier_sales',
	'sold_out_history',
	// Category sales and product mix (#227), slow sellers (#261), order step
	// timings (#243) and missed online sales (#176).
	'product_mix',
	'product_mix_options',
	'slow_sellers',
	'order_timings',
	'missed_online_sales',
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

/** What a line sold before the menu and category were stamped is grouped under (#227). */
export const EARLIER_SALES_REPORT_LABEL = 'Earlier sales'

const mixDimensionFields: ReportField[] = [
	{
		id: 'occurredAt',
		label: 'Date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description: 'When the sale was placed (web and QR) or rung up (Station).',
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
		label: 'Location id',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	channelField,
	{
		id: 'currency',
		label: 'Currency',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'menu',
		label: 'Menu',
		type: 'string',
		filterable: true,
		groupable: true,
		description: `The menu the dish was sold under at the time of sale. Lines sold before this was recorded read "${EARLIER_SALES_REPORT_LABEL}".`,
	},
	{
		id: 'menuId',
		label: 'Menu id',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'category',
		label: 'Category',
		type: 'string',
		filterable: true,
		groupable: true,
		description: `The category the dish was sold under at the time of sale, not today's. Renaming a category changes no past sale. Lines sold before this was recorded read "${EARLIER_SALES_REPORT_LABEL}".`,
	},
	{
		id: 'categoryId',
		label: 'Category id',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'item',
		label: 'Dish',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'itemId',
		label: 'Dish id',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
]

const productMixFields: ReportField[] = [
	...mixDimensionFields,
	{
		id: 'quantity',
		label: 'Quantity',
		type: 'number',
		sumLabel: 'Quantity sold',
		averageLabel: false,
	},
	{
		id: 'sales',
		label: 'Net sales',
		type: 'currency',
		sumLabel: 'Net sales',
		averageLabel: 'Average line sale',
		description:
			'Dish sales including option charges, after discounts and rewards, before tax, tips and fees (the items-sold rule).',
	},
	{
		id: 'grossSales',
		label: 'Gross sales',
		type: 'currency',
		sumLabel: 'Gross item sales',
		averageLabel: false,
		description: 'Price times quantity, before discounts.',
	},
	{
		id: 'averagePrice',
		label: 'Average price',
		type: 'ratio',
		ratio: { numerator: 'sales', denominator: 'quantity', unit: 'each' },
		description: 'Net sales divided by quantity sold.',
	},
]

const productMixOptionFields: ReportField[] = [
	...mixDimensionFields,
	{
		id: 'optionGroup',
		label: 'Option group',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'option',
		label: 'Option',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'quantity',
		label: 'Quantity',
		type: 'number',
		sumLabel: 'Times chosen',
		averageLabel: false,
	},
	{
		id: 'sales',
		label: 'Option sales',
		type: 'currency',
		sumLabel: 'Option sales',
		averageLabel: false,
		description:
			'The options’ share of the dish’s net sales. Already part of the dish’s sales: never add it to them.',
	},
]

/** How a dish is doing in the period: set by the loader, listed in this order. */
export const SLOW_SELLER_STATUS_OPTIONS = [
	{ value: 'ranked', label: 'Ranked' },
	{ value: 'new', label: 'New (added during the period)' },
	{ value: 'limited', label: 'Not available the whole period' },
] as const

const slowSellerFields: ReportField[] = [
	{
		id: 'periodEnd',
		label: 'Period end',
		type: 'datetime',
		timeframe: true,
		listable: false,
		description: 'The end of the period the dish was ranked over.',
	},
	{
		id: 'item',
		label: 'Dish',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'itemId',
		label: 'Dish id',
		type: 'string',
		filterable: true,
		listable: false,
	},
	{
		id: 'category',
		label: 'Category',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'The first category the dish is in on the menu today.',
	},
	{
		id: 'categoryId',
		label: 'Category id',
		type: 'string',
		filterable: true,
		listable: false,
	},
	{
		id: 'location',
		label: 'Location',
		type: 'string',
		filterable: true,
		description: 'Narrows the sales counted to one location.',
	},
	{
		id: 'locationId',
		label: 'Location id',
		type: 'string',
		filterable: true,
		listable: false,
		description: 'Narrows the sales counted to one location.',
	},
	{
		id: 'currency',
		label: 'Currency',
		type: 'string',
		filterable: true,
		listable: false,
	},
	{
		id: 'channel',
		label: 'Channel',
		type: 'enum',
		filterable: true,
		options: channelField.options,
		description: 'Narrows the sales counted to one channel.',
	},
	{
		id: 'quantity',
		label: 'Quantity sold',
		type: 'number',
		sumLabel: 'Quantity sold',
		averageLabel: false,
	},
	{
		id: 'sales',
		label: 'Net sales',
		type: 'currency',
		sumLabel: 'Net sales',
		averageLabel: false,
	},
	{
		id: 'shareOfOrders',
		label: 'Share of orders',
		type: 'number',
		sumLabel: false,
		averageLabel: false,
		description:
			'Percent of the orders in the period (with the same location and channel) that had this dish.',
	},
	{
		id: 'daysSinceLastSold',
		label: 'Days since last sold',
		type: 'number',
		sumLabel: false,
		averageLabel: false,
		description:
			'Days the dish was available since it last sold. Days it was sold out or hidden are not counted. Empty: not sold in the period.',
	},
	{
		id: 'availableWholePeriod',
		label: 'Available the whole period',
		type: 'boolean',
		filterable: true,
		description:
			'No sold-out or hidden time in the period, and on the menu all of it.',
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		options: [...SLOW_SELLER_STATUS_OPTIONS],
		description:
			'A dish added during the period is New and listed after the ranked ones, so a new dish is not ranked against a full month.',
	},
	{
		id: 'foodCostPercent',
		label: 'Food cost',
		type: 'number',
		sumLabel: false,
		averageLabel: false,
		requiresSubject: 'inventory_cost',
		description:
			'Plate cost over the menu price, with recipes on. Only for members who may see costs.',
	},
	{
		id: 'sortKey',
		label: 'Rank',
		type: 'number',
		listable: false,
		sumLabel: false,
		averageLabel: false,
		description: 'Orders the list: fewest sold first, new dishes after.',
	},
]

const orderTimingFields: ReportField[] = [
	{
		id: 'placedAt',
		label: 'Placed at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
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
		label: 'Location id',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'fulfillment',
		label: 'Fulfillment',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'pickup', label: 'Pickup' },
			{ value: 'delivery', label: 'Delivery' },
			{ value: 'dine_in', label: 'Dine-in' },
			{ value: 'drive_through', label: 'Drive-through' },
		],
	},
	{
		id: 'locationTimeZone',
		label: 'Location time zone',
		type: 'string',
		listable: false,
	},
	{
		id: 'orders',
		label: 'Orders',
		type: 'number',
		sumLabel: 'Orders',
		averageLabel: false,
	},
	{
		id: 'minutesToAccept',
		label: 'Minutes to accept',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average minutes to accept',
		description:
			'From placed to accepted, for orders a person had to accept. Orders accepted automatically are left out.',
	},
	{
		id: 'minutesToStart',
		label: 'Minutes to start',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average minutes to start',
	},
	{
		id: 'minutesToReady',
		label: 'Minutes to ready',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average minutes from placed to ready',
		description:
			'From placed to ready. A step undone and done again counts at its latest time.',
	},
	{
		id: 'minutesLate',
		label: 'Minutes late',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average minutes late (negative: early)',
		description: 'Ready time against the time promised to the guest.',
	},
	{
		id: 'lateOrders',
		label: 'Late orders',
		type: 'number',
		sumLabel: 'Late orders',
		averageLabel: false,
		description: 'Orders that were ready after the promised time.',
	},
	{
		id: 'promisedOrders',
		label: 'Orders with a promised time',
		type: 'number',
		sumLabel: 'Orders with a promised time',
		averageLabel: false,
		listable: false,
	},
	{
		id: 'lateRate',
		label: 'Late against promised',
		type: 'ratio',
		ratio: {
			numerator: 'lateOrders',
			denominator: 'promisedOrders',
			unit: 'percent',
		},
		description: 'Share of orders with a promised time that were ready late.',
	},
]

const missedSalesFields: ReportField[] = [
	{
		id: 'startedAt',
		label: 'Pause started',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
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
		label: 'Location id',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'currency',
		label: 'Currency',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
	{
		id: 'minutesPaused',
		label: 'Minutes paused',
		type: 'duration',
		sumLabel: 'Minutes paused (open hours only)',
		averageLabel: false,
	},
	{
		id: 'estimatedOrders',
		label: 'Estimated orders missed',
		type: 'number',
		sumLabel: 'Estimated orders missed',
		averageLabel: false,
		description: 'An estimate, never counted as real orders.',
	},
	{
		id: 'estimatedSales',
		label: 'Estimated missed online sales',
		type: 'currency',
		sumLabel: 'Estimated missed online sales',
		averageLabel: false,
		description:
			'An estimate from the same weekday and hours over the previous weeks, never added to real sales.',
	},
	{
		id: 'weeksUsed',
		label: 'Weeks the estimate is based on',
		type: 'number',
		sumLabel: false,
		averageLabel: false,
	},
]

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
		id: 'product_mix',
		label: 'Product mix',
		description:
			'Dishes sold with the menu and category they were sold under at the time, for category sales and the product mix tree. Web, QR and Station sales that count toward sales.',
		scope: 'organization',
		source: 'tenant-api',
		fields: productMixFields,
		currencyField: 'currency',
		splitCurrencies: true,
		defaultColumns: ['item', 'category', 'quantity', 'sales', 'averagePrice'],
	},
	{
		id: 'product_mix_options',
		label: 'Product mix options',
		description:
			'Options chosen on dishes, with the menu and category of the dish at the time of sale.',
		scope: 'organization',
		source: 'tenant-api',
		fields: productMixOptionFields,
		currencyField: 'currency',
		splitCurrencies: true,
		defaultColumns: ['optionGroup', 'option', 'item', 'quantity', 'sales'],
	},
	{
		id: 'slow_sellers',
		label: 'Slow sellers',
		description:
			'Menu dishes ranked from the fewest sold, with the ones that did not sell at all first.',
		scope: 'organization',
		source: 'tenant-api',
		fields: slowSellerFields,
		currencyField: 'currency',
		// Fewest sold first, new dishes after; location and channel decide
		// which sales a dish is ranked on, so the loader reads them.
		listOrder: { field: 'sortKey', direction: 'asc' },
		// Rows name their dish, so a row can link to it (open, mark unavailable,
		// start a promotion).
		rowRefField: 'itemId',
		loaderFilterFields: ['location', 'locationId', 'channel'],
		defaultColumns: [
			'item',
			'category',
			'quantity',
			'sales',
			'shareOfOrders',
			'daysSinceLastSold',
			'availableWholePeriod',
			'status',
		],
	},
	{
		id: 'order_timings',
		label: 'Order timings',
		description:
			'How long online orders took from placed to accepted, started and ready, and how often they were late against the promised time.',
		scope: 'organization',
		source: 'tenant-api',
		fields: orderTimingFields,
		timeZoneField: 'locationTimeZone',
		defaultColumns: [
			'placedAt',
			'location',
			'fulfillment',
			'minutesToAccept',
			'minutesToReady',
			'minutesLate',
		],
	},
	{
		id: 'missed_online_sales',
		label: 'Missed online sales (estimate)',
		description:
			'Online ordering pauses with an estimate of the web and QR sales missed while paused. An estimate, never added to real sales.',
		scope: 'organization',
		source: 'tenant-api',
		fields: missedSalesFields,
		currencyField: 'currency',
		splitCurrencies: true,
		defaultColumns: [
			'startedAt',
			'location',
			'minutesPaused',
			'estimatedOrders',
			'estimatedSales',
			'weeksUsed',
		],
	},
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
