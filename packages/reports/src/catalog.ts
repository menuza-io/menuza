import { type Measure, type ValueMeasure } from './dsl.ts'

export type ReportScope = 'organization' | 'platform'
/**
 * Where a subject's records load: the App database, the regional tenant API
 * (from the browser), or connected third-party integrations (on the App).
 */
export type ReportSource = 'control-plane' | 'tenant-api' | 'integrations'
export type ReportFieldType =
	'datetime' | 'boolean' | 'enum' | 'string' | 'number' | 'currency'

export type ReportField = {
	id: string
	label: string
	type: ReportFieldType
	description?: string
	filterable?: boolean
	groupable?: boolean
	timeframe?: boolean
	options?: Array<{ value: string; label: string }>
	/** Include this field as a list-table column. Defaults to true. */
	listable?: boolean
	/**
	 * Restricted subject whose permission this field also needs, because its
	 * values are derived from that subject's records.
	 */
	requiresSubject?: string
	/**
	 * Number and currency fields: what the sum or average is called. `false`
	 * hides that measure where it means nothing (a sum of star ratings).
	 */
	sumLabel?: string | false
	averageLabel?: string | false
}

export type ReportSubject = {
	id: string
	label: string
	description: string
	scope: ReportScope
	source: ReportSource
	fields: ReportField[]
	/** Record field holding the ISO currency code of currency fields. */
	currencyField?: string
	/** List columns used when a list report picks none. */
	defaultColumns?: string[]
}

export type ReportCatalog = {
	scope: ReportScope
	subjects: ReportSubject[]
}

const customerFields: ReportField[] = [
	{
		id: 'createdAt',
		label: 'Created at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		description: 'When the customer first signed in on the public site.',
	},
	{
		id: 'name',
		label: 'Name',
		type: 'string',
		filterable: true,
	},
	{
		id: 'email',
		label: 'Email',
		type: 'string',
		filterable: true,
	},
	{
		id: 'phone',
		label: 'Phone',
		type: 'string',
		filterable: true,
	},
	{
		id: 'phoneVerified',
		label: 'Phone verified',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'hasEmail',
		label: 'Has email',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'Email marketing reaches customers who added an email.',
	},
	{
		id: 'textSubscriber',
		label: 'Text subscriber',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'Opted in to texts and has not opted out.',
	},
	{
		id: 'hasOrdered',
		label: 'Has ordered',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'Placed at least one order that counts toward sales.',
		requiresSubject: 'orders',
	},
	{
		id: 'firstOrderAt',
		label: 'First order at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		description: 'When the customer placed their first order.',
		requiresSubject: 'orders',
	},
	{
		id: 'lastOrderAt',
		label: 'Last order at',
		type: 'datetime',
		timeframe: true,
		requiresSubject: 'orders',
	},
	{
		id: 'firstOrderSource',
		label: 'First order from',
		type: 'enum',
		filterable: true,
		groupable: true,
		description: 'Whether the first order came from your menu or a drop.',
		requiresSubject: 'orders',
		options: [
			{ value: 'menu', label: 'Menu' },
			{ value: 'drop', label: 'Drop' },
			{ value: 'none', label: 'No orders yet' },
		],
	},
	{
		id: 'orderCount',
		label: 'Orders',
		type: 'number',
		description: 'Orders that count toward sales.',
		requiresSubject: 'orders',
		averageLabel: 'Orders per customer',
	},
	{
		id: 'totalSpent',
		label: 'Total spent',
		type: 'currency',
		description: 'Order totals across orders that count toward sales.',
		requiresSubject: 'orders',
		averageLabel: 'Average spend per customer',
	},
	{
		id: 'currency',
		label: 'Currency',
		type: 'enum',
		filterable: true,
		groupable: true,
		listable: false,
		description: 'The currency the customer orders in.',
		requiresSubject: 'orders',
	},
]

const noteFields: ReportField[] = [
	{
		id: 'createdAt',
		label: 'Created at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'title',
		label: 'Title',
		type: 'string',
		filterable: true,
	},
	{
		id: 'updatedAt',
		label: 'Updated at',
		type: 'datetime',
		timeframe: true,
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
	},
	{
		id: 'priority',
		label: 'Priority',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'low', label: 'Low' },
			{ value: 'medium', label: 'Medium' },
			{ value: 'high', label: 'High' },
			{ value: 'urgent', label: 'Urgent' },
		],
	},
	{
		id: 'isPublic',
		label: 'Visibility',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
]

const memberFields: ReportField[] = [
	{
		id: 'createdAt',
		label: 'Joined at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'name',
		label: 'Name',
		type: 'string',
		filterable: true,
	},
	{
		id: 'email',
		label: 'Email',
		type: 'string',
		filterable: true,
	},
	{
		id: 'role',
		label: 'Role',
		type: 'enum',
		filterable: true,
		groupable: true,
	},
	{
		id: 'department',
		label: 'Department',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'active',
		label: 'Active',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
]

const shopOrderFields: ReportField[] = [
	{
		id: 'createdAt',
		label: 'Ordered at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		description: 'When the shop order was placed.',
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'pending', label: 'Pending' },
			{ value: 'paid', label: 'Paid' },
			{ value: 'failed', label: 'Failed' },
			{ value: 'refunded', label: 'Refunded' },
		],
	},
	{
		id: 'productName',
		label: 'Product',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'amount',
		label: 'Amount',
		type: 'currency',
		sumLabel: 'Shop sales',
		averageLabel: 'Average shop order',
	},
	{
		id: 'orgPayout',
		label: 'Org payout',
		type: 'currency',
		averageLabel: 'Average payout',
	},
	{
		id: 'currency',
		label: 'Currency',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [{ value: 'usd', label: 'USD' }],
	},
	{
		id: 'customerName',
		label: 'Customer name',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'Name from the signed-in customer profile, if available.',
	},
	{
		id: 'customerPhone',
		label: 'Customer phone',
		type: 'string',
		filterable: true,
		groupable: false,
	},
	{
		id: 'customerEmail',
		label: 'Customer email',
		type: 'string',
		filterable: true,
		groupable: false,
	},
]

const feedbackFields: ReportField[] = [
	{
		id: 'createdAt',
		label: 'Submitted at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'type',
		label: 'Type',
		type: 'enum',
		filterable: true,
		groupable: true,
	},
]

const phoneCallFields: ReportField[] = [
	{
		id: 'startedAt',
		label: 'Started at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'callerPhone',
		label: 'Caller',
		type: 'string',
		filterable: true,
	},
	{
		id: 'channel',
		label: 'Channel',
		type: 'enum',
		filterable: true,
		groupable: true,
		description: 'Real phone calls or browser test calls.',
		options: [
			{ value: 'phone', label: 'Phone' },
			{ value: 'web_test', label: 'Test call' },
		],
	},
	{
		id: 'purpose',
		label: 'Purpose',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'Why the caller rang. Purposes added by your business type show by name.',
		options: [
			{ value: 'business_information', label: 'Business info' },
			{ value: 'other', label: 'Other' },
			{ value: 'unknown', label: 'Unknown' },
		],
	},
	{
		id: 'outcome',
		label: 'Outcome',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'resolved', label: 'Resolved' },
			{ value: 'link_sent', label: 'Link sent' },
			{ value: 'escalated', label: 'Transferred' },
			{ value: 'message_taken', label: 'Message taken' },
			{ value: 'abandoned', label: 'Hung up early' },
			{ value: 'failed', label: 'Failed' },
			{ value: 'unknown', label: 'Unknown' },
		],
	},
	{
		id: 'resolvedByAssistant',
		label: 'Handled without staff',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description:
			'The call ended resolved or with a link texted, with no transfer or message for staff.',
	},
	{
		id: 'transferResult',
		label: 'Transfer',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'none', label: 'No transfer' },
			{ value: 'answered', label: 'Staff picked up' },
			{ value: 'no_answer', label: 'Nobody answered' },
			{ value: 'referred', label: 'Handed to the main line' },
		],
	},
	{
		id: 'calledWhileOpen',
		label: 'Called while open',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'durationBucket',
		label: 'Call length',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'under_1', label: 'Under 1 minute' },
			{ value: '1_to_3', label: '1 to 3 minutes' },
			{ value: '3_to_5', label: '3 to 5 minutes' },
			{ value: 'over_5', label: 'Over 5 minutes' },
		],
	},
	{
		id: 'linkSent',
		label: 'Link texted',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'repeatCaller',
		label: 'Repeat caller',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'The same number called earlier in the last 30 days.',
	},
	{
		id: 'followUpStatus',
		label: 'Follow-up',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'open', label: 'Needs follow-up' },
			{ value: 'resolved', label: 'Complete' },
		],
	},
	{
		id: 'rating',
		label: 'Caller rating',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: '1', label: '1' },
			{ value: '2', label: '2' },
			{ value: '3', label: '3' },
			{ value: '4', label: '4' },
			{ value: '5', label: '5' },
			{ value: 'none', label: 'Not rated' },
		],
	},
	{
		id: 'sentiment',
		label: 'Sentiment',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'positive', label: 'Positive' },
			{ value: 'neutral', label: 'Neutral' },
			{ value: 'negative', label: 'Negative' },
			{ value: 'unknown', label: 'Unknown' },
		],
	},
]

const orderedAtField: ReportField = {
	id: 'createdAt',
	label: 'Ordered at',
	type: 'datetime',
	timeframe: true,
	groupable: true,
	description: 'When the customer placed the order.',
}

const orderNumberField: ReportField = {
	id: 'orderNumber',
	label: 'Order number',
	type: 'string',
	filterable: true,
}

const orderLocationField: ReportField = {
	id: 'location',
	label: 'Location',
	type: 'string',
	filterable: true,
	groupable: true,
}

const orderFulfillmentField: ReportField = {
	id: 'fulfillment',
	label: 'Fulfillment',
	type: 'enum',
	filterable: true,
	groupable: true,
	options: [
		{ value: 'pickup', label: 'Pickup' },
		{ value: 'delivery', label: 'Delivery' },
	],
}

const orderSourceField: ReportField = {
	id: 'source',
	label: 'Source',
	type: 'enum',
	filterable: true,
	groupable: true,
	description: 'Whether the order came from your menu or a drop.',
	options: [
		{ value: 'menu', label: 'Menu' },
		{ value: 'drop', label: 'Drop' },
	],
}

const orderDropField: ReportField = {
	id: 'drop',
	label: 'Drop',
	type: 'string',
	filterable: true,
	groupable: true,
	description: 'The drop the order was placed for, if any.',
}

const orderCurrencyField: ReportField = {
	id: 'currency',
	label: 'Currency',
	type: 'enum',
	filterable: true,
	groupable: true,
	listable: false,
}

const orderFields: ReportField[] = [
	orderedAtField,
	{
		id: 'completedAt',
		label: 'Completed at',
		type: 'datetime',
		timeframe: true,
	},
	orderNumberField,
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'awaiting_payment', label: 'Awaiting payment' },
			{ value: 'accepted', label: 'New order' },
			{ value: 'preparing', label: 'Preparing' },
			{ value: 'ready', label: 'Ready' },
			{ value: 'completed', label: 'Completed' },
			{ value: 'cancelled', label: 'Cancelled' },
			{ value: 'expired', label: 'Expired' },
			{ value: 'payment_review', label: 'Payment needs review' },
		],
	},
	{
		id: 'countsTowardSales',
		label: 'Counts toward sales',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description:
			'Open and completed orders, once online payment has gone through. Cancelled, expired, and unpaid online orders are left out.',
	},
	orderFulfillmentField,
	{
		id: 'paymentMethod',
		label: 'Payment method',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'online', label: 'Online' },
			{ value: 'handoff', label: 'Pay at handoff' },
		],
	},
	{
		id: 'paymentStatus',
		label: 'Payment status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'unpaid', label: 'Unpaid' },
			{ value: 'pending', label: 'Pending' },
			{ value: 'paid', label: 'Paid' },
			{ value: 'failed', label: 'Failed' },
			{ value: 'expired', label: 'Expired' },
			{ value: 'review', label: 'In review' },
		],
	},
	{
		id: 'timing',
		label: 'Timing',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'asap', label: 'As soon as possible' },
			{ value: 'scheduled', label: 'Scheduled' },
		],
	},
	orderSourceField,
	orderDropField,
	orderLocationField,
	{
		id: 'customerType',
		label: 'Customer type',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'First orders are from customers with no earlier order that counts toward sales, matched by account or phone number.',
		options: [
			{ value: 'new', label: 'First order' },
			{ value: 'returning', label: 'Returning customer' },
		],
	},
	{
		id: 'attributedChannel',
		label: 'Marketing attribution',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'Orders placed within 7 days after the customer received one of your emails or texts. The most recent message gets the credit.',
		options: [
			{ value: 'email', label: 'Email' },
			{ value: 'sms', label: 'Text message' },
			{ value: 'none', label: 'Not attributed' },
		],
	},
	{
		id: 'customerName',
		label: 'Customer name',
		type: 'string',
		filterable: true,
	},
	{
		id: 'customerPhone',
		label: 'Customer phone',
		type: 'string',
		filterable: true,
	},
	{
		id: 'customerEmail',
		label: 'Customer email',
		type: 'string',
		filterable: true,
	},
	{
		id: 'total',
		label: 'Order total',
		type: 'currency',
		description:
			'What the customer paid: subtotal, tax, delivery fee, and tip.',
		sumLabel: 'Sales',
		averageLabel: 'Average order value',
	},
	{
		id: 'subtotal',
		label: 'Subtotal',
		type: 'currency',
		description: 'Items and options before tax, delivery fee, and tip.',
		averageLabel: 'Average subtotal',
	},
	{
		id: 'tax',
		label: 'Tax',
		type: 'currency',
		sumLabel: 'Taxes',
	},
	{
		id: 'tip',
		label: 'Tip',
		type: 'currency',
		sumLabel: 'Tips',
	},
	{
		id: 'tipPercent',
		label: 'Tip percent',
		type: 'number',
		sumLabel: false,
		averageLabel: 'Average tip percent',
	},
	{
		id: 'deliveryFee',
		label: 'Delivery fee',
		type: 'currency',
		sumLabel: 'Delivery fees',
	},
	{
		id: 'itemCount',
		label: 'Item count',
		type: 'number',
		sumLabel: 'Items sold',
		averageLabel: 'Items per order',
	},
	orderCurrencyField,
]

const orderItemFields: ReportField[] = [
	orderedAtField,
	{
		id: 'itemName',
		label: 'Item',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'quantity',
		label: 'Quantity',
		type: 'number',
		sumLabel: 'Quantity sold',
	},
	{
		id: 'sales',
		label: 'Item sales',
		type: 'currency',
		description:
			'Price times quantity, including option charges, before tax and tips.',
		averageLabel: 'Average item sale',
	},
	orderNumberField,
	orderLocationField,
	orderFulfillmentField,
	orderSourceField,
	orderDropField,
	orderCurrencyField,
]

const orderOptionFields: ReportField[] = [
	orderedAtField,
	{
		id: 'groupName',
		label: 'Option group',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'optionName',
		label: 'Option',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'itemName',
		label: 'Item',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'quantity',
		label: 'Quantity',
		type: 'number',
		sumLabel: 'Quantity sold',
	},
	{
		id: 'sales',
		label: 'Option sales',
		type: 'currency',
		description: 'Extra charges for the option, times the item quantity.',
		averageLabel: 'Average option charge',
	},
	orderNumberField,
	orderLocationField,
	orderFulfillmentField,
	orderSourceField,
	orderDropField,
	orderCurrencyField,
]

const textSubscriberFields: ReportField[] = [
	{
		id: 'subscribedAt',
		label: 'Subscribed at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		description: 'When the customer last opted in.',
	},
	{
		id: 'unsubscribedAt',
		label: 'Unsubscribed at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'subscribed', label: 'Subscribed' },
			{ value: 'unsubscribed', label: 'Unsubscribed' },
		],
	},
	{
		id: 'source',
		label: 'Signed up from',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'menu', label: 'Menu' },
			{ value: 'drops_page', label: 'Drops page' },
			{ value: 'drop_page', label: 'Drop page' },
			{ value: 'order_success', label: 'Order confirmation' },
			{ value: 'profile', label: 'Profile' },
		],
	},
	{
		id: 'topic',
		label: 'Topic',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [{ value: 'drops', label: 'Drops' }],
	},
	{
		id: 'customerName',
		label: 'Customer name',
		type: 'string',
		filterable: true,
	},
	{
		id: 'customerPhone',
		label: 'Customer phone',
		type: 'string',
		filterable: true,
	},
]

const reviewFields: ReportField[] = [
	{
		id: 'createdAt',
		label: 'Posted at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'rating',
		label: 'Rating',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: '1', label: '1 star' },
			{ value: '2', label: '2 stars' },
			{ value: '3', label: '3 stars' },
			{ value: '4', label: '4 stars' },
			{ value: '5', label: '5 stars' },
			{ value: 'none', label: 'Not rated' },
		],
	},
	{
		id: 'stars',
		label: 'Star rating',
		type: 'number',
		description: 'Reviews without a star rating are left out of averages.',
		sumLabel: false,
		averageLabel: 'Average rating',
	},
	{
		id: 'provider',
		label: 'Review site',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'google-business-profile', label: 'Google' },
			{ value: 'yelp', label: 'Yelp' },
			{ value: 'tripadvisor', label: 'TripAdvisor' },
			{ value: 'deliveroo', label: 'Deliveroo' },
			{ value: 'just-eat', label: 'Just Eat' },
			{ value: 'opentable', label: 'OpenTable' },
			{ value: 'resy', label: 'Resy' },
		],
	},
	{
		id: 'location',
		label: 'Location',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'replied',
		label: 'Replied',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'reviewer',
		label: 'Reviewer',
		type: 'string',
		filterable: true,
	},
]

export const organizationCatalog: ReportCatalog = {
	scope: 'organization',
	subjects: [
		{
			id: 'orders',
			label: 'Orders',
			description: 'Menu and drop orders placed on your site.',
			scope: 'organization',
			source: 'tenant-api',
			fields: orderFields,
			currencyField: 'currency',
			defaultColumns: [
				'orderNumber',
				'customerName',
				'status',
				'total',
				'createdAt',
			],
		},
		{
			id: 'order_items',
			label: 'Items sold',
			description:
				'Menu items on orders that count toward sales, one row per order line.',
			scope: 'organization',
			source: 'tenant-api',
			fields: orderItemFields,
			currencyField: 'currency',
			defaultColumns: [
				'itemName',
				'quantity',
				'sales',
				'orderNumber',
				'createdAt',
			],
		},
		{
			id: 'order_options',
			label: 'Options sold',
			description:
				'Options and add-ons chosen on items in orders that count toward sales.',
			scope: 'organization',
			source: 'tenant-api',
			fields: orderOptionFields,
			currencyField: 'currency',
			defaultColumns: [
				'groupName',
				'optionName',
				'itemName',
				'quantity',
				'sales',
				'createdAt',
			],
		},
		{
			id: 'customers',
			label: 'Customers',
			description: 'Customers who signed in on the public site.',
			scope: 'organization',
			source: 'tenant-api',
			fields: customerFields,
			currencyField: 'currency',
			defaultColumns: ['name', 'email', 'phone', 'createdAt'],
		},
		{
			id: 'text_subscribers',
			label: 'Text subscribers',
			description: 'Customers who opted in to texts, including later opt-outs.',
			scope: 'organization',
			source: 'tenant-api',
			fields: textSubscriberFields,
			defaultColumns: [
				'customerName',
				'customerPhone',
				'status',
				'source',
				'subscribedAt',
			],
		},
		{
			id: 'reviews',
			label: 'Reviews',
			description: 'Reviews from connected review sites, newest first.',
			scope: 'organization',
			source: 'integrations',
			fields: reviewFields,
			defaultColumns: [
				'reviewer',
				'provider',
				'rating',
				'location',
				'createdAt',
			],
		},
		{
			id: 'shop_orders',
			label: 'Shop orders',
			description: 'Customer purchases from the public site shop (US only).',
			scope: 'organization',
			source: 'tenant-api',
			fields: shopOrderFields,
			currencyField: 'currency',
		},
		{
			id: 'phone_calls',
			label: 'Phone calls',
			description: 'Calls answered by the AI phone agent (US only).',
			scope: 'organization',
			source: 'tenant-api',
			fields: phoneCallFields,
		},
		{
			id: 'notes',
			label: 'Notes',
			description: 'Organization notes created by operators.',
			scope: 'organization',
			source: 'control-plane',
			fields: noteFields,
		},
		{
			id: 'members',
			label: 'Members',
			description: 'Operators who belong to this organization.',
			scope: 'organization',
			source: 'control-plane',
			fields: memberFields,
		},
		{
			id: 'feedback',
			label: 'Feedback',
			description: 'In-app feedback submitted by operators.',
			scope: 'organization',
			source: 'control-plane',
			fields: feedbackFields,
		},
	],
}

export const platformCatalog: ReportCatalog = {
	scope: 'platform',
	subjects: [
		{
			id: 'organizations',
			label: 'Organizations',
			description: 'Tenant organizations on the platform.',
			scope: 'platform',
			source: 'control-plane',
			fields: [
				{
					id: 'createdAt',
					label: 'Created at',
					type: 'datetime',
					timeframe: true,
					groupable: true,
				},
				{
					id: 'name',
					label: 'Name',
					type: 'string',
					filterable: true,
				},
				{
					id: 'slug',
					label: 'Slug',
					type: 'string',
					filterable: true,
				},
				{
					id: 'dataRegion',
					label: 'Data region',
					type: 'enum',
					filterable: true,
					groupable: true,
					options: [
						{ value: 'us', label: 'United States' },
						{ value: 'ksa', label: 'Saudi Arabia' },
					],
				},
				{
					id: 'active',
					label: 'Active',
					type: 'boolean',
					filterable: true,
					groupable: true,
				},
				{
					id: 'sitePublished',
					label: 'Site published',
					type: 'boolean',
					filterable: true,
					groupable: true,
				},
				{
					id: 'subscriptionStatus',
					label: 'Subscription',
					type: 'enum',
					filterable: true,
					groupable: true,
				},
				{
					id: 'planName',
					label: 'Plan',
					type: 'enum',
					filterable: true,
					groupable: true,
				},
			],
		},
		{
			id: 'users',
			label: 'Users',
			description: 'Operator accounts across the platform.',
			scope: 'platform',
			source: 'control-plane',
			fields: [
				{
					id: 'createdAt',
					label: 'Created at',
					type: 'datetime',
					timeframe: true,
					groupable: true,
				},
				{
					id: 'name',
					label: 'Name',
					type: 'string',
					filterable: true,
				},
				{
					id: 'username',
					label: 'Username',
					type: 'string',
					filterable: true,
				},
				{
					id: 'email',
					label: 'Email',
					type: 'string',
					filterable: true,
				},
				{
					id: 'isBanned',
					label: 'Banned',
					type: 'boolean',
					filterable: true,
					groupable: true,
				},
			],
		},
		{
			id: 'waitlist',
			label: 'Waitlist',
			description: 'Closed-beta waitlist entries.',
			scope: 'platform',
			source: 'control-plane',
			fields: [
				{
					id: 'createdAt',
					label: 'Joined at',
					type: 'datetime',
					timeframe: true,
					groupable: true,
				},
				{
					id: 'hasEarlyAccess',
					label: 'Early access',
					type: 'boolean',
					filterable: true,
					groupable: true,
				},
				{
					id: 'hasJoinedDiscord',
					label: 'Joined Discord',
					type: 'boolean',
					filterable: true,
					groupable: true,
				},
			],
		},
		{
			id: 'feedback',
			label: 'Feedback',
			description: 'Operator feedback across every organization.',
			scope: 'platform',
			source: 'control-plane',
			fields: [
				{
					id: 'createdAt',
					label: 'Submitted at',
					type: 'datetime',
					timeframe: true,
					groupable: true,
				},
				{
					id: 'type',
					label: 'Type',
					type: 'enum',
					filterable: true,
					groupable: true,
				},
			],
		},
		{
			id: 'sessions',
			label: 'Sessions',
			description: 'Operator browser sessions.',
			scope: 'platform',
			source: 'control-plane',
			fields: [
				{
					id: 'createdAt',
					label: 'Created at',
					type: 'datetime',
					timeframe: true,
					groupable: true,
				},
			],
		},
		{
			id: 'audit_logs',
			label: 'Audit logs',
			description: 'Control-plane audit events. Details stay aggregated.',
			scope: 'platform',
			source: 'control-plane',
			fields: [
				{
					id: 'createdAt',
					label: 'Occurred at',
					type: 'datetime',
					timeframe: true,
					groupable: true,
				},
				{
					id: 'action',
					label: 'Action',
					type: 'enum',
					filterable: true,
					groupable: true,
				},
				{
					id: 'severity',
					label: 'Severity',
					type: 'enum',
					filterable: true,
					groupable: true,
					options: [
						{ value: 'info', label: 'Info' },
						{ value: 'warning', label: 'Warning' },
						{ value: 'error', label: 'Error' },
						{ value: 'critical', label: 'Critical' },
					],
				},
			],
		},
	],
}

export function getCatalog(scope: ReportScope): ReportCatalog {
	return scope === 'platform' ? platformCatalog : organizationCatalog
}

export function getSubject(catalog: ReportCatalog, subjectId: string) {
	return catalog.subjects.find((subject) => subject.id === subjectId) ?? null
}

export function getField(subject: ReportSubject, fieldId: string) {
	return subject.fields.find((field) => field.id === fieldId) ?? null
}

export function timeframeFields(subject: ReportSubject) {
	return subject.fields.filter((field) => field.timeframe)
}

export function groupableFields(subject: ReportSubject) {
	return subject.fields.filter((field) => field.groupable)
}

export function filterableFields(subject: ReportSubject) {
	return subject.fields.filter((field) => field.filterable)
}

export function listableFields(subject: ReportSubject) {
	return subject.fields.filter((field) => field.listable !== false)
}

export function defaultListColumns(subject: ReportSubject) {
	if (subject.defaultColumns?.length) return subject.defaultColumns
	const fields = listableFields(subject).filter(
		(field) => !field.requiresSubject,
	)
	const identity = fields.filter(
		(field) => field.type !== 'datetime' && field.type !== 'boolean',
	)
	const rest = fields.filter((field) => !identity.includes(field))
	return [...identity, ...rest].slice(0, 4).map((field) => field.id)
}

export function isValueFieldType(type: ReportFieldType) {
	return type === 'number' || type === 'currency'
}

/**
 * What summing or averaging `field` is called, or null when that measure
 * doesn't apply to it.
 */
export function valueMeasureLabel(
	measure: ValueMeasure,
	field: ReportField,
): string | null {
	if (!isValueFieldType(field.type)) return null
	const custom = measure === 'sum' ? field.sumLabel : field.averageLabel
	if (custom === false) return null
	if (custom) return custom
	if (measure === 'sum') return field.label
	return `Average ${field.label.charAt(0).toLowerCase()}${field.label.slice(1)}`
}

/** Number and currency fields `measure` can read; all of them without one. */
export function valueFields(subject: ReportSubject, measure?: Measure) {
	return subject.fields.filter((field) => {
		if (!isValueFieldType(field.type)) return false
		if (measure === 'sum' || measure === 'average') {
			return valueMeasureLabel(measure, field) !== null
		}
		return true
	})
}

export function defaultTimeframeField(subject: ReportSubject) {
	return timeframeFields(subject)[0] ?? subject.fields[0]
}
