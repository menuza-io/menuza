import { type ReportField, type ReportSubject } from './catalog.ts'

/**
 * Sales across every channel (#84), refunds and cancelled or voided orders
 * (#228). The three subjects load in the region from web and QR orders
 * (`restaurant_orders`) and Station sales (`pos_orders`), and are granted with
 * the other order subjects.
 *
 * One definition of a sale, shared with the items-sold reader and the till's
 * day report: a web or QR order counts once it is open or completed and
 * payable; a Station sale counts when it is paid or refunded. The rounds of a
 * QR tab rung up on a Station till are that till sale, never both.
 */

/**
 * The staff name on a Station sale. Not a subject: the token lists it for
 * people who may see who worked (timesheet access, or managing terminals), and
 * the staff fields are absent for everyone else.
 */
export const SALES_STAFF_FIELD_PERMISSION = 'sales_staff' as const

export const SALES_REPORT_SUBJECTS = [
	'sales',
	'order_refunds',
	'cancelled_orders',
	'cash_drawer_shifts',
	'cash_drawer_movements',
] as const
export type SalesReportSubject = (typeof SALES_REPORT_SUBJECTS)[number]

export function isSalesReportSubject(
	subject: string,
): subject is SalesReportSubject {
	return SALES_REPORT_SUBJECTS.some((item) => item === subject)
}

/** Longest range one run of a sales subject may cover. */
export const SALES_REPORT_MAX_RANGE_DAYS = 400

/**
 * What the two sales figures hold, in words. Shown next to the Gross / Net
 * switch and stated in exports, so a figure never has to be guessed (#331).
 */
export const SALES_BASIS_DEFINITIONS = {
	gross:
		'Gross sales: items and fees before discounts and refunds. Tax and tips are not included.',
	net: 'Net sales: items and fees after discounts, loyalty rewards and refunds. Tax and tips are not included. A refund lowers net sales on the day the money went back.',
} as const

const channelOptions = [
	{ value: 'online_menu', label: 'Online menu' },
	{ value: 'drop', label: 'Drop' },
	{ value: 'qr_table', label: 'QR table' },
	{ value: 'qr_poster', label: 'QR poster' },
	{ value: 'station_counter', label: 'Station counter' },
	{ value: 'station_phone', label: 'Station phone order' },
]

const tenderOptions = [
	{ value: 'card_online', label: 'Card online' },
	{ value: 'cash', label: 'Cash' },
	{ value: 'card_till', label: 'Card at the till' },
	{ value: 'gift_card', label: 'Gift card' },
	{ value: 'other', label: 'Other' },
	{ value: 'handoff', label: 'Pay at handoff' },
	{ value: 'none', label: 'Nothing to pay' },
]

const locationField: ReportField = {
	id: 'location',
	label: 'Location',
	type: 'string',
	filterable: true,
	groupable: true,
}

const hiddenFields: ReportField[] = [
	{
		id: 'locationId',
		label: 'Location id',
		type: 'string',
		listable: false,
	},
	{
		id: 'locationTimeZone',
		label: 'Location time zone',
		type: 'string',
		listable: false,
	},
]

const currencyField: ReportField = {
	id: 'currency',
	label: 'Currency',
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
	options: channelOptions,
}

const salesFields: ReportField[] = [
	{
		id: 'occurredAt',
		label: 'Date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description:
			'When the sale was placed or rung up. A refund is dated the day the money went back, so a report by refund date and one by sale date can differ.',
	},
	{
		id: 'fulfilledAt',
		label: 'Fulfilment time',
		type: 'datetime',
		showTime: true,
		description:
			'The scheduled time of a scheduled order, otherwise when it was completed, otherwise when it was placed.',
	},
	locationField,
	...hiddenFields,
	channelField,
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
			{ value: 'takeaway', label: 'Takeaway' },
			{ value: 'drive_through', label: 'Drive-through' },
		],
	},
	{
		id: 'tender',
		label: 'Tender',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'How the sale was paid. A sale paid two ways is split between them.',
		options: tenderOptions,
	},
	{
		id: 'staffName',
		label: 'Staff member',
		type: 'string',
		filterable: true,
		groupable: true,
		description:
			'Who rang up a Station sale. Online sales have no staff member and group as Online.',
		requiresSubject: SALES_STAFF_FIELD_PERMISSION,
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'paid', label: 'Paid' },
			{ value: 'refunded', label: 'Refunded' },
			{ value: 'voided', label: 'Voided' },
		],
	},
	{
		id: 'entry',
		label: 'Entry',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'A sale, a refund (dated the day the money went back) or a sale voided at the till.',
		options: [
			{ value: 'sale', label: 'Sale' },
			{ value: 'refund', label: 'Refund' },
			{ value: 'void', label: 'Voided sale' },
		],
	},
	{
		id: 'customerType',
		label: 'Customer type',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'First-time or returning, for online sales. Station sales are not tied to a customer.',
		options: [
			{ value: 'new', label: 'First-time' },
			{ value: 'returning', label: 'Returning' },
			{ value: 'station', label: 'Station (not tracked)' },
		],
	},
	{
		id: 'orderNumber',
		label: 'Order',
		type: 'string',
		filterable: true,
	},
	currencyField,
	{
		id: 'sales',
		label: 'Sales',
		type: 'currency',
		listable: false,
		sumLabel: 'Sales',
		averageLabel: false,
		description: `Gross or net, as the report's Gross / Net switch says. ${SALES_BASIS_DEFINITIONS.gross} ${SALES_BASIS_DEFINITIONS.net}`,
	},
	{
		id: 'grossSales',
		label: 'Gross sales',
		type: 'currency',
		sumLabel: 'Gross sales',
		averageLabel: false,
		description: SALES_BASIS_DEFINITIONS.gross,
	},
	{
		id: 'discounts',
		label: 'Discounts',
		type: 'currency',
		sumLabel: 'Discounts',
		averageLabel: false,
		description: 'What discounts and coupons took off, delivery included.',
	},
	{
		id: 'loyaltyRewards',
		label: 'Loyalty rewards',
		type: 'currency',
		sumLabel: 'Loyalty rewards',
		averageLabel: false,
	},
	{
		id: 'cashDiscounts',
		label: 'Cash discounts',
		type: 'currency',
		sumLabel: 'Cash discounts',
		averageLabel: false,
		description:
			'What the cash-payment discount took off Station sales paid in cash. Counted apart from discounts and loyalty rewards, and included in gross sales.',
	},
	{
		id: 'tax',
		label: 'Tax',
		type: 'currency',
		sumLabel: 'Tax',
		averageLabel: false,
		description: 'Tax on sales, less the tax share of refunds.',
	},
	{
		id: 'tips',
		label: 'Tips',
		type: 'currency',
		sumLabel: 'Tips',
		averageLabel: false,
	},
	{
		id: 'serviceCharges',
		label: 'Service charges',
		type: 'currency',
		sumLabel: 'Service charges',
		averageLabel: false,
		description:
			'Automatic service charges, large-party gratuities, and guest service fees, reported apart from tips.',
	},
	{
		id: 'taxExempt',
		label: 'Tax exempt',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'Whether the order was marked tax-exempt with a certificate.',
	},
	{
		id: 'taxExemptSales',
		label: 'Tax-exempt sales',
		type: 'currency',
		sumLabel: 'Tax-exempt sales',
		averageLabel: false,
		description: 'Net sales on orders marked tax-exempt.',
	},
	{
		id: 'refunds',
		label: 'Refunds',
		type: 'currency',
		sumLabel: 'Refunds',
		averageLabel: false,
		description:
			'Money given back, counted on the day it went back, tax and tips included.',
	},
	{
		id: 'netSales',
		label: 'Net sales',
		type: 'currency',
		sumLabel: 'Net sales',
		averageLabel: false,
		description: SALES_BASIS_DEFINITIONS.net,
	},
	{
		id: 'collected',
		label: 'Total collected',
		type: 'currency',
		sumLabel: 'Total collected',
		averageLabel: false,
		description:
			'What guests paid, tax and tips included, less refunds. This is the figure the till day report and the online order total add up to.',
	},
	{
		id: 'saleCount',
		label: 'Number of sales',
		type: 'number',
		sumLabel: 'Number of sales',
		averageLabel: false,
		listable: false,
		description: 'Closed sales. Refunds and voided sales are not counted.',
	},
	{
		id: 'averageSale',
		label: 'Average sale',
		type: 'ratio',
		ratio: { numerator: 'sales', denominator: 'saleCount', unit: 'each' },
		description:
			'Sales divided by the number of sales, gross or net as the report says.',
	},
	{
		id: 'voidCount',
		label: 'Voided sales',
		type: 'number',
		sumLabel: 'Voided sales',
		averageLabel: false,
		listable: false,
	},
	{
		id: 'voidAmount',
		label: 'Voided amount',
		type: 'currency',
		sumLabel: 'Voided amount',
		averageLabel: false,
		description:
			'What voided sales came to. Voided sales are left out of every sales total.',
	},
]

export const salesSubject: ReportSubject = {
	id: 'sales',
	label: 'Sales',
	description:
		'Every closed sale from your online menu, QR ordering and Station tills in one place, with refunds on the day the money went back.',
	scope: 'organization',
	source: 'tenant-api',
	fields: salesFields,
	currencyField: 'currency',
	timeZoneField: 'locationTimeZone',
	defaultColumns: [
		'occurredAt',
		'orderNumber',
		'entry',
		'channel',
		'tender',
		'netSales',
		'collected',
	],
	maxRangeDays: SALES_REPORT_MAX_RANGE_DAYS,
	splitCurrencies: true,
	timeBasisFields: { placed: 'occurredAt', fulfillment: 'fulfilledAt' },
	salesBasisField: { field: 'sales', gross: 'grossSales', net: 'netSales' },
}

const refundFields: ReportField[] = [
	{
		id: 'refundedAt',
		label: 'Refund date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description: 'The day the money went back.',
	},
	locationField,
	...hiddenFields,
	{
		id: 'orderNumber',
		label: 'Order',
		type: 'string',
		filterable: true,
	},
	channelField,
	{
		id: 'paymentMethod',
		label: 'Payment method',
		type: 'enum',
		filterable: true,
		groupable: true,
		description: 'How the money went back.',
		options: tenderOptions.filter((option) => option.value !== 'none'),
	},
	{
		id: 'amount',
		label: 'Refunded amount',
		type: 'currency',
		sumLabel: 'Refunded',
		averageLabel: 'Average refund',
	},
	{
		id: 'originalTotal',
		label: 'Original amount',
		type: 'currency',
		sumLabel: false,
		averageLabel: false,
		description: 'What the order came to before any refund.',
	},
	{
		id: 'extent',
		label: 'Full or partial',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'full', label: 'Full refund' },
			{ value: 'partial', label: 'Partial refund' },
		],
	},
	{
		id: 'refundedBy',
		label: 'Refunded by',
		type: 'string',
		filterable: true,
		groupable: true,
		description:
			'The team member or Station staff member who gave the refund, the guest (a cancelled order) or the system (an order not accepted in time).',
	},
	{
		id: 'reason',
		label: 'Reason',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	currencyField,
]

export const orderRefundsSubject: ReportSubject = {
	id: 'order_refunds',
	label: 'Refunds',
	description:
		'Every refund once, with its amount, its reason and who gave it. A partial refund is its own row.',
	scope: 'organization',
	source: 'tenant-api',
	fields: refundFields,
	currencyField: 'currency',
	timeZoneField: 'locationTimeZone',
	defaultColumns: [
		'refundedAt',
		'orderNumber',
		'amount',
		'originalTotal',
		'paymentMethod',
		'refundedBy',
		'reason',
	],
	maxRangeDays: SALES_REPORT_MAX_RANGE_DAYS,
	splitCurrencies: true,
}

const cancelledFields: ReportField[] = [
	{
		id: 'placedAt',
		label: 'Order date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description:
			'When the order was placed or rung up. Cancelled orders are always dated by when they were placed.',
	},
	{
		id: 'cancelledAt',
		label: 'Cancelled at',
		type: 'datetime',
		showTime: true,
	},
	locationField,
	...hiddenFields,
	{
		id: 'orderNumber',
		label: 'Order',
		type: 'string',
		filterable: true,
	},
	channelField,
	{
		id: 'entry',
		label: 'What was cancelled',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'order', label: 'Whole order' },
			{ value: 'item', label: 'Item taken off' },
		],
	},
	{
		id: 'reasonGroup',
		label: 'Reason group',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'expired_unpaid', label: 'Expired unpaid' },
			{ value: 'rejected_by_restaurant', label: 'Rejected by the restaurant' },
			{ value: 'cancelled_by_guest', label: 'Cancelled by the guest' },
			{ value: 'cancelled_by_staff', label: 'Cancelled by staff' },
			{ value: 'voided_at_till', label: 'Voided at the till' },
		],
	},
	{
		id: 'reason',
		label: 'Reason',
		type: 'enum',
		filterable: true,
		groupable: true,
		description: 'The reason picked when it was cancelled, when one was.',
		options: [
			{ value: 'out_of_stock', label: 'Out of stock' },
			{ value: 'kitchen_closed', label: 'Kitchen closed' },
			{ value: 'guest_asked', label: 'Guest asked' },
			{ value: 'duplicate', label: 'Duplicate order' },
			{ value: 'too_busy', label: 'Too busy' },
			{ value: 'not_accepted_in_time', label: 'Not accepted in time' },
			{ value: 'payment_expired', label: 'Payment not completed' },
			{ value: 'mistake', label: 'Mistake' },
			{ value: 'guest_request', label: 'Guest request' },
			{ value: 'quality', label: 'Quality' },
			{ value: 'wrong_charge', label: 'Wrong charge' },
			{ value: 'other', label: 'Other' },
			{ value: 'none', label: 'No reason given' },
		],
	},
	{
		id: 'amount',
		label: 'Amount',
		type: 'currency',
		sumLabel: 'Amount not sold',
		averageLabel: false,
		description:
			'What the order, or the item taken off, came to. None of it is in sales.',
	},
	{
		id: 'dishName',
		label: 'Dish',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'The dish taken off a Station order.',
	},
	{
		id: 'quantity',
		label: 'Quantity',
		type: 'number',
		sumLabel: 'Items taken off',
		averageLabel: false,
	},
	{
		id: 'staffName',
		label: 'Staff member',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'Who voided it at the till.',
		requiresSubject: SALES_STAFF_FIELD_PERMISSION,
	},
	{
		id: 'guestName',
		label: 'Guest',
		type: 'string',
		filterable: true,
		description: 'The name on the order. Needs access to customers.',
		requiresSubject: 'customers',
	},
	currencyField,
]

export const cancelledOrdersSubject: ReportSubject = {
	id: 'cancelled_orders',
	label: 'Cancelled and voided orders',
	description:
		'Orders that never counted toward sales, and items taken off at the till, with the reason.',
	scope: 'organization',
	source: 'tenant-api',
	fields: cancelledFields,
	currencyField: 'currency',
	timeZoneField: 'locationTimeZone',
	defaultColumns: [
		'placedAt',
		'orderNumber',
		'entry',
		'reasonGroup',
		'reason',
		'amount',
	],
	maxRangeDays: SALES_REPORT_MAX_RANGE_DAYS,
	splitCurrencies: true,
}

const cashDrawerShiftFields: ReportField[] = [
	{
		id: 'closedAt',
		label: 'Shift date',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description:
			'When the shift closed, or when it opened for a shift still open.',
	},
	{
		id: 'openedAt',
		label: 'Opened at',
		type: 'datetime',
		showTime: true,
	},
	{
		id: 'businessDate',
		label: 'Business day',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	locationField,
	...hiddenFields,
	{
		id: 'terminal',
		label: 'Terminal',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'open', label: 'Open' },
			{ value: 'closed', label: 'Closed' },
		],
	},
	{
		id: 'cashierName',
		label: 'Cashier',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'Who opened the cash drawer shift.',
		requiresSubject: SALES_STAFF_FIELD_PERMISSION,
	},
	{
		id: 'closedByName',
		label: 'Closed by',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'Who closed the shift on the terminal.',
		requiresSubject: SALES_STAFF_FIELD_PERMISSION,
	},
	{
		id: 'closedRemotely',
		label: 'Closed remotely',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'remoteCloserName',
		label: 'Remote closer',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'Manager who closed the shift remotely from the dashboard.',
		requiresSubject: SALES_STAFF_FIELD_PERMISSION,
	},
	{
		id: 'remoteCloseReason',
		label: 'Remote close reason',
		type: 'string',
		filterable: true,
	},
	{
		id: 'openingFloat',
		label: 'Opening float',
		type: 'currency',
		sumLabel: 'Opening float',
		averageLabel: false,
	},
	{
		id: 'expectedCash',
		label: 'Expected cash',
		type: 'currency',
		sumLabel: 'Expected cash',
		averageLabel: false,
	},
	{
		id: 'countedCash',
		label: 'Counted cash',
		type: 'currency',
		sumLabel: 'Counted cash',
		averageLabel: false,
	},
	{
		id: 'variance',
		label: 'Over / short',
		type: 'currency',
		sumLabel: 'Variance',
		averageLabel: 'Average variance',
		description: 'Counted cash minus expected cash (negative is short).',
	},
	{
		id: 'varianceFlagged',
		label: 'Flagged variance',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description:
			'True when the absolute difference between counted and expected cash exceeds the location threshold.',
	},
	currencyField,
]

export const cashDrawerShiftsSubject: ReportSubject = {
	id: 'cash_drawer_shifts',
	label: 'Cash drawer variance',
	description:
		'Expected against counted cash for every Station shift, with differences by terminal and cashier.',
	scope: 'organization',
	source: 'tenant-api',
	fields: cashDrawerShiftFields,
	currencyField: 'currency',
	timeZoneField: 'locationTimeZone',
	defaultColumns: [
		'closedAt',
		'terminal',
		'location',
		'expectedCash',
		'countedCash',
		'variance',
		'varianceFlagged',
	],
	maxRangeDays: SALES_REPORT_MAX_RANGE_DAYS,
	splitCurrencies: true,
}

const cashDrawerMovementFields: ReportField[] = [
	{
		id: 'occurredAt',
		label: 'Time',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
	},
	{
		id: 'businessDate',
		label: 'Business day',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	locationField,
	...hiddenFields,
	{
		id: 'terminal',
		label: 'Terminal',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'shiftId',
		label: 'Shift',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'kind',
		label: 'Movement',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'pay_in', label: 'Pay-in' },
			{ value: 'pay_out', label: 'Pay-out' },
			{ value: 'drop', label: 'Safe drop' },
		],
	},
	{
		id: 'amount',
		label: 'Amount',
		type: 'currency',
		sumLabel: 'Total moved',
		averageLabel: 'Average movement',
	},
	{
		id: 'signedAmount',
		label: 'Drawer effect',
		type: 'currency',
		sumLabel: 'Net drawer effect',
		averageLabel: false,
	},
	{
		id: 'note',
		label: 'Reason',
		type: 'string',
		filterable: true,
	},
	{
		id: 'staffName',
		label: 'Staff member',
		type: 'string',
		filterable: true,
		groupable: true,
		requiresSubject: SALES_STAFF_FIELD_PERMISSION,
	},
	{
		id: 'approvedByName',
		label: 'Approved by',
		type: 'string',
		filterable: true,
		groupable: true,
		requiresSubject: SALES_STAFF_FIELD_PERMISSION,
	},
	currencyField,
]

export const cashDrawerMovementsSubject: ReportSubject = {
	id: 'cash_drawer_movements',
	label: 'Cash drawer log',
	description:
		'Pay-ins, pay-outs and safe drops recorded in Station cash drawers.',
	scope: 'organization',
	source: 'tenant-api',
	fields: cashDrawerMovementFields,
	currencyField: 'currency',
	timeZoneField: 'locationTimeZone',
	defaultColumns: ['occurredAt', 'terminal', 'kind', 'amount', 'note'],
	maxRangeDays: SALES_REPORT_MAX_RANGE_DAYS,
	splitCurrencies: true,
}

export const salesReportSubjects: ReportSubject[] = [
	salesSubject,
	orderRefundsSubject,
	cancelledOrdersSubject,
	cashDrawerShiftsSubject,
	cashDrawerMovementsSubject,
]
