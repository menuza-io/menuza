import { type ReportField, type ReportSubject } from './catalog.ts'

/**
 * Gift card report subjects (#110, #216). They read the regional tenant
 * database in tenant-api and are restricted subjects: a token lists them only
 * when Gift cards are on and the person holds `read:gift_card:any`.
 *
 * Rows are money facts only: an amount, a day, a location, a channel, a status
 * and an age. No field carries a code, a name or an email. A gift card sale is
 * never revenue in a sales report, and a redemption is a tender, not a
 * discount: these subjects are the only place gift card money is counted, so
 * the accounting export (#189) can read them as sold, redeemed and outstanding.
 */
export const GIFT_CARD_REPORT_SUBJECTS = [
	'gift_card_sales',
	'gift_card_redemptions',
	'gift_card_balances',
	'gift_card_settlement',
] as const
export type GiftCardReportSubject = (typeof GIFT_CARD_REPORT_SUBJECTS)[number]

export function isGiftCardReportSubject(
	subject: string,
): subject is GiftCardReportSubject {
	return GIFT_CARD_REPORT_SUBJECTS.some((item) => item === subject)
}

const CHANNELS = [
	{ value: 'online', label: 'Online' },
	{ value: 'pos', label: 'Till' },
	{ value: 'app', label: 'App' },
	{ value: 'import', label: 'Import' },
	{ value: 'system', label: 'Menuza' },
]

const locationField = (id: string, label: string): ReportField => ({
	id,
	label,
	type: 'string',
	filterable: true,
	groupable: true,
})

const amountField = (id: string, label: string, sumLabel: string): ReportField => ({
	id,
	label,
	type: 'currency',
	sumLabel,
	averageLabel: false,
})

const countField: ReportField = {
	id: 'cards',
	label: 'Cards',
	type: 'number',
	listable: false,
	sumLabel: 'Cards',
	averageLabel: false,
}

const dayField: ReportField = {
	id: 'businessDate',
	label: 'Day',
	type: 'string',
	filterable: true,
	groupable: true,
	description: 'The day (YYYY-MM-DD) in the report’s time zone.',
}

const salesFields: ReportField[] = [
	{ id: 'at', label: 'When', type: 'datetime', timeframe: true, groupable: true, showTime: true },
	dayField,
	locationField('location', 'Selling location'),
	{
		id: 'channel',
		label: 'Channel',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: CHANNELS,
	},
	{
		id: 'kind',
		label: 'Kind',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'issue', label: 'Card sold' },
			{ value: 'top_up', label: 'Top-up' },
			{ value: 'import', label: 'Imported balance' },
		],
	},
	amountField('amount', 'Amount', 'Gift card sales'),
	{ id: 'currency', label: 'Currency', type: 'string', listable: false },
]

const redemptionFields: ReportField[] = [
	{ id: 'at', label: 'When', type: 'datetime', timeframe: true, groupable: true, showTime: true },
	dayField,
	locationField('location', 'Spent at'),
	locationField('sellingLocation', 'Sold at'),
	{
		id: 'channel',
		label: 'Channel',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: CHANNELS,
	},
	amountField(
		'amount',
		'Amount spent',
		'Gift card redemptions',
	),
	{ id: 'currency', label: 'Currency', type: 'string', listable: false },
]

const balanceFields: ReportField[] = [
	{ id: 'issuedAt', label: 'Issued', type: 'datetime', timeframe: true, groupable: true },
	{ id: 'lastUsedAt', label: 'Last used', type: 'datetime', groupable: true },
	locationField('sellingLocation', 'Sold at'),
	{
		id: 'ageBucket',
		label: 'Age',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: '0-3 months', label: '0 to 3 months' },
			{ value: '3-12 months', label: '3 to 12 months' },
			{ value: '1-2 years', label: '1 to 2 years' },
			{ value: 'older', label: 'Older' },
		],
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'active', label: 'Active' },
			{ value: 'held', label: 'On hold' },
			{ value: 'frozen', label: 'Frozen' },
			{ value: 'inactive', label: 'Not activated' },
		],
	},
	amountField('balance', 'Balance', 'Outstanding balance'),
	countField,
	{ id: 'currency', label: 'Currency', type: 'string', listable: false },
]

const settlementFields: ReportField[] = [
	{ id: 'at', label: 'When', type: 'datetime', timeframe: true, groupable: true, showTime: true },
	dayField,
	locationField('location', 'Location'),
	{
		id: 'side',
		label: 'Side',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'owed', label: 'Sold the card (owed)' },
			{ value: 'owes', label: 'Took it as payment (owes)' },
		],
	},
	{
		...amountField('net', 'Net amount', 'Net between locations'),
		description:
			'Positive for the location that sold a card spent elsewhere (owed), negative for the location that took it as payment (owes). Across all locations the net is always zero. A report only: no money moves.',
	},
	{ id: 'currency', label: 'Currency', type: 'string', listable: false },
]

export const giftCardSubjects: ReportSubject[] = [
	{
		id: 'gift_card_sales',
		label: 'Gift card sales',
		description:
			'Cards sold and topped up, by location, channel and day. Not food revenue. Needs gift card access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: salesFields,
		currencyField: 'currency',
		defaultColumns: ['at', 'location', 'channel', 'kind', 'amount'],
	},
	{
		id: 'gift_card_redemptions',
		label: 'Gift card redemptions',
		description:
			'Gift card money spent, by location and channel. A payment method, not a discount; a refund back to the card reverses it where it was spent. Needs gift card access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: redemptionFields,
		currencyField: 'currency',
		defaultColumns: ['at', 'location', 'sellingLocation', 'channel', 'amount'],
	},
	{
		id: 'gift_card_balances',
		label: 'Gift card balances',
		description:
			'Money still owed to guests on cards, by selling location and age, with the last time each was used. Needs gift card access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: balanceFields,
		currencyField: 'currency',
		defaultColumns: ['issuedAt', 'sellingLocation', 'ageBucket', 'lastUsedAt', 'balance'],
	},
	{
		id: 'gift_card_settlement',
		label: 'Gift cards between locations',
		description:
			'What each location owes or is owed for cards sold at one place and spent at another. Nets to zero; moves no money. Needs gift card access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: settlementFields,
		currencyField: 'currency',
		defaultColumns: ['at', 'location', 'side', 'net'],
	},
]
