import { type Measure, type ValueMeasure } from './dsl.ts'

export type ReportScope = 'organization' | 'platform'
export type ReportSource = 'control-plane' | 'tenant-api'
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

export const organizationCatalog: ReportCatalog = {
	scope: 'organization',
	subjects: [
		{
			id: 'customers',
			label: 'Customers',
			description: 'Customers who signed in on the public site.',
			scope: 'organization',
			source: 'tenant-api',
			fields: customerFields,
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
	const fields = listableFields(subject)
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
