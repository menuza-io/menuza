import { type ReportField, type ReportSubject } from './catalog.ts'

/**
 * Staff report subjects. They read the regional tenant database (time cards,
 * the schedule, daily labor figures, applications) in tenant-api, never the US
 * control plane, and each one is a restricted subject: a token lists it only
 * when the person holds the matching staffing permission and the staffing flag
 * is on (see `operator-token.ts`). Every record carries the IANA zone of its
 * scope so days are the scope's days.
 *
 * Money fields are estimates from rate snapshots, never payroll, and a field
 * that reveals one person's pay names `staff_pay` in `requiresSubject`.
 */

/**
 * Staff report subjects, read from the regional staff tables. The App lists
 * one in a token only when the staffing flag for it is on, the person holds the
 * matching permission (timesheets, schedule, labor or hiring access) and has
 * staffing access to at least one scope. The token also carries the
 * `scopeIds` those subjects are limited to.
 */
export const STAFFING_REPORT_SUBJECTS = [
	'time_entries',
	'shifts',
	'labor_daily',
	'applications',
] as const
export type StaffingReportSubject = (typeof STAFFING_REPORT_SUBJECTS)[number]

/**
 * The permission to see one person's wages (`read:staff_pay:any`). It is not a
 * subject anyone can report on; fields that reveal a person's pay name it in
 * `requiresSubject` so the same check covers them.
 */
export const STAFF_PAY_REPORT_PERMISSION = 'staff_pay' as const

/** Whether `subject` is one of the loadable staff subjects. */
export function isStaffingReportSubject(
	subject: string,
): subject is StaffingReportSubject {
	return STAFFING_REPORT_SUBJECTS.some((staffing) => staffing === subject)
}

/**
 * Minutes late after which an arrival counts as late. Shared by the loader and
 * the field description so the two cannot drift.
 */
export const ON_TIME_GRACE_MINUTES = 5

const scopeField: ReportField = {
	id: 'scope',
	label: 'Workplace',
	type: 'string',
	filterable: true,
	groupable: true,
}

const employeeField: ReportField = {
	id: 'employee',
	label: 'Employee',
	type: 'string',
	filterable: true,
	groupable: true,
}

const positionField: ReportField = {
	id: 'position',
	label: 'Position',
	type: 'string',
	filterable: true,
	groupable: true,
	description: 'The position the person worked or was scheduled for.',
}

const currencyField: ReportField = {
	id: 'currency',
	label: 'Currency',
	type: 'enum',
	filterable: true,
	groupable: true,
	listable: false,
}

const timeEntryFields: ReportField[] = [
	{
		id: 'clockInAt',
		label: 'Clocked in at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description: 'When the person clocked in, in the workplace’s time zone.',
	},
	{
		id: 'clockOutAt',
		label: 'Clocked out at',
		type: 'datetime',
		timeframe: true,
		showTime: true,
	},
	employeeField,
	positionField,
	scopeField,
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'open', label: 'Open' },
			{ value: 'needs_review', label: 'Needs review' },
			{ value: 'closed', label: 'Closed' },
			{ value: 'approved', label: 'Approved' },
			{ value: 'locked', label: 'Locked' },
		],
	},
	{
		id: 'arrival',
		label: 'Arrival',
		type: 'enum',
		filterable: true,
		groupable: true,
		description: `On time means clocking in no more than ${ON_TIME_GRACE_MINUTES} minutes after the scheduled start. Unscheduled means no shift was planned that day.`,
		options: [
			{ value: 'on_time', label: 'On time' },
			{ value: 'late', label: 'Late' },
			{ value: 'unscheduled', label: 'Unscheduled' },
		],
	},
	{
		id: 'edited',
		label: 'Edited by a manager',
		type: 'boolean',
		filterable: true,
		groupable: true,
	},
	{
		id: 'paidMinutes',
		label: 'Paid hours',
		type: 'duration',
		description: 'Time worked minus unpaid breaks.',
		sumLabel: 'Paid hours',
		averageLabel: 'Average paid hours per time card',
	},
	{
		id: 'regularMinutes',
		label: 'Regular hours',
		type: 'duration',
		sumLabel: 'Regular hours',
		averageLabel: 'Average regular hours per time card',
	},
	{
		id: 'overtimeMinutes',
		label: 'Overtime hours',
		type: 'duration',
		description: 'Overtime and double time, from the workplace’s labor rules.',
		sumLabel: 'Overtime hours',
		averageLabel: 'Average overtime hours per time card',
	},
	{
		id: 'breakMinutes',
		label: 'Unpaid break',
		type: 'duration',
		sumLabel: 'Unpaid break time',
		averageLabel: 'Average unpaid break per time card',
	},
	{
		id: 'lateMinutes',
		label: 'Minutes late',
		type: 'duration',
		description: 'How long after the scheduled start the person clocked in.',
		sumLabel: false,
		averageLabel: 'Average time late',
	},
	{
		id: 'cost',
		label: 'Labor cost',
		type: 'currency',
		description:
			'Estimated wages from the pay rate at clock-in. An estimate, not payroll.',
		requiresSubject: 'staff_pay',
		sumLabel: 'Labor cost',
		averageLabel: 'Average labor cost per time card',
	},
	currencyField,
	{
		id: 'timeZone',
		label: 'Time zone',
		type: 'string',
		listable: false,
	},
]

const shiftFields: ReportField[] = [
	{
		id: 'startsAt',
		label: 'Starts at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description: 'When the shift starts, in the workplace’s time zone.',
	},
	{
		id: 'endsAt',
		label: 'Ends at',
		type: 'datetime',
		timeframe: true,
		showTime: true,
	},
	employeeField,
	positionField,
	scopeField,
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'draft', label: 'Draft' },
			{ value: 'published', label: 'Published' },
		],
	},
	{
		id: 'openShift',
		label: 'Open shift',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'Nobody holds the shift yet.',
	},
	{
		id: 'scheduledMinutes',
		label: 'Scheduled hours',
		type: 'duration',
		description: 'Shift length minus the unpaid break.',
		sumLabel: 'Scheduled hours',
		averageLabel: 'Average shift length',
	},
	{
		id: 'timeZone',
		label: 'Time zone',
		type: 'string',
		listable: false,
	},
]

const SALES_SOURCE_OPTIONS = [
	{ value: 'online_orders', label: 'Online orders (not all sales)' },
	{ value: 'online_only', label: 'Online orders (all sales)' },
	{ value: 'manual', label: 'Entered sales' },
]

/**
 * The caveat every labor share carries: the sales behind it depend on the
 * scope's sales source, and wages are estimates.
 */
export const LABOR_SHARE_CAVEAT =
	'Wages are estimates from pay rates, not payroll. Sales are the online orders that count toward sales, or the sales your team entered, depending on each workplace’s sales source. A workplace that counts online orders only will read higher than its true labor share.'

const laborDailyFields: ReportField[] = [
	{
		id: 'date',
		label: 'Day',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		description:
			'The workplace’s business day, in the workplace’s time zone (a day can start after midnight).',
	},
	scopeField,
	{
		id: 'salesSource',
		label: 'Sales source',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'Where the workplace’s sales come from, which decides what a labor share means.',
		options: SALES_SOURCE_OPTIONS,
	},
	{
		id: 'paidMinutes',
		label: 'Paid hours',
		type: 'duration',
		sumLabel: 'Paid hours',
		averageLabel: 'Average paid hours per day',
	},
	{
		id: 'overtimeMinutes',
		label: 'Overtime hours',
		type: 'duration',
		sumLabel: 'Overtime hours',
		averageLabel: 'Average overtime hours per day',
	},
	{
		id: 'scheduledMinutes',
		label: 'Scheduled hours',
		type: 'duration',
		description: 'Published shifts for the day, minus unpaid breaks.',
		sumLabel: 'Scheduled hours',
		averageLabel: 'Average scheduled hours per day',
	},
	{
		id: 'varianceMinutes',
		label: 'Actual minus scheduled hours',
		type: 'duration',
		description: 'Positive when more hours were worked than scheduled.',
		sumLabel: 'Hours over or under schedule',
		averageLabel: 'Average hours over or under schedule per day',
	},
	{
		id: 'shifts',
		label: 'Scheduled shifts',
		type: 'number',
		sumLabel: 'Scheduled shifts',
		averageLabel: 'Average scheduled shifts per day',
	},
	{
		id: 'clockIns',
		label: 'Clock-ins',
		type: 'number',
		description: 'Time cards that started that day.',
		sumLabel: 'Clock-ins',
		averageLabel: 'Average clock-ins per day',
	},
	{
		id: 'people',
		label: 'People who worked',
		type: 'number',
		sumLabel: false,
		averageLabel: 'Average people working per day',
	},
	{
		id: 'laborCost',
		label: 'Labor cost',
		type: 'currency',
		description: 'Estimated wages. Empty when the day has no priced time.',
		sumLabel: 'Labor cost',
		averageLabel: 'Average labor cost per day',
	},
	{
		id: 'sales',
		label: 'Sales',
		type: 'currency',
		description:
			'Net sales before tax, tips and fees. Empty when no sales are known for the day.',
		sumLabel: 'Sales',
		averageLabel: 'Average sales per day',
	},
	{
		id: 'tips',
		label: 'Tips from online orders',
		type: 'currency',
		sumLabel: 'Tips from online orders',
		averageLabel: 'Average tips per day',
	},
	{
		id: 'currencyMismatch',
		label: 'Wages in another currency',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description:
			'Wages were paid in a currency other than the sales. They are never converted, so the day is left out of labor shares.',
	},
	{
		id: 'laborCostPercent',
		label: 'Labor cost as a share of sales',
		type: 'ratio',
		listable: false,
		description: LABOR_SHARE_CAVEAT,
		ratio: { numerator: 'laborCost', denominator: 'sales', unit: 'percent' },
	},
	{
		id: 'salesPerLaborHour',
		label: 'Sales per labor hour',
		type: 'ratio',
		listable: false,
		description: LABOR_SHARE_CAVEAT,
		ratio: {
			numerator: 'sales',
			denominator: 'paidMinutes',
			unit: 'per_hour',
		},
	},
	currencyField,
	{
		id: 'timeZone',
		label: 'Time zone',
		type: 'string',
		listable: false,
	},
]

const APPLICATION_STAGE_OPTIONS = [
	{ value: 'new', label: 'New' },
	{ value: 'screening', label: 'Screening' },
	{ value: 'interview', label: 'Interview' },
	{ value: 'offer', label: 'Offer' },
	{ value: 'hired', label: 'Hired' },
	{ value: 'declined', label: 'Declined' },
]

const applicationFields: ReportField[] = [
	{
		id: 'appliedAt',
		label: 'Applied at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
	},
	{
		id: 'position',
		label: 'Position',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	scopeField,
	{
		id: 'stage',
		label: 'Stage',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: APPLICATION_STAGE_OPTIONS,
	},
	{
		id: 'source',
		label: 'Source',
		type: 'enum',
		filterable: true,
		groupable: true,
		description: 'Where the applicant found the job.',
		options: [
			{ value: 'careers_page', label: 'Careers page' },
			{ value: 'qr', label: 'QR code' },
			{ value: 'share_link', label: 'Shared link' },
		],
	},
	{
		id: 'daysToDecision',
		label: 'Days to decision',
		type: 'number',
		description: 'Days from applying to being hired or declined.',
		sumLabel: false,
		averageLabel: 'Average days to decision',
	},
	{
		id: 'timeZone',
		label: 'Time zone',
		type: 'string',
		listable: false,
	},
]

export const staffingSubjects: ReportSubject[] = [
	{
		id: 'time_entries',
		label: 'Time cards',
		description:
			'One row per time card: who clocked in where, hours, overtime and arrival. Needs timesheet access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: timeEntryFields,
		currencyField: 'currency',
		timeZoneField: 'timeZone',
		defaultColumns: [
			'clockInAt',
			'employee',
			'position',
			'paidMinutes',
			'status',
		],
	},
	{
		id: 'shifts',
		label: 'Scheduled shifts',
		description:
			'One row per shift on the schedule, including open shifts. Needs schedule access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: shiftFields,
		timeZoneField: 'timeZone',
		defaultColumns: ['startsAt', 'employee', 'position', 'scheduledMinutes'],
	},
	{
		id: 'labor_daily',
		label: 'Daily labor',
		description:
			'One row per workplace and business day: hours, scheduled hours, wages and sales. Needs labor access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: laborDailyFields,
		currencyField: 'currency',
		timeZoneField: 'timeZone',
		defaultColumns: ['date', 'scope', 'paidMinutes', 'laborCost', 'sales'],
	},
	{
		id: 'applications',
		label: 'Applications',
		description:
			'Job applications by stage, position and source. Needs hiring access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: applicationFields,
		timeZoneField: 'timeZone',
		defaultColumns: ['appliedAt', 'position', 'scope', 'stage'],
	},
]
