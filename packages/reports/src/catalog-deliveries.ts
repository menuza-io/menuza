import { type ReportField, type ReportSubject } from './catalog.ts'

/**
 * Own-driver delivery reports (#324). Two subjects load in the region from the
 * run and stop tables (`delivery_runs`, `delivery_run_stops`) and the order step
 * rows:
 *
 * - `deliveries`: one record per delivery a driver made (or could not make),
 *   with the minutes from ready to picked up and from picked up to delivered,
 *   the promised time, cash, tip and problem;
 * - `driver_deliveries`: one record per driver for the report's period, the
 *   figures of the first added up. It is what "Deliveries by driver" reads, and
 *   each row names the driver so the screen can open that driver's deliveries.
 *
 * Both are listed in a reports token only while `delivery.in_house` is on, and
 * only for members who may read orders. A record holds a zone and minutes and
 * money, never a guest name, phone or address. The driver's name is staff data:
 * the `driver` field carries it only for a token with the staff grant
 * (`SALES_STAFF_FIELD_PERMISSION`, the same grant as the staff name on Station
 * sales, #84); without it the field holds "Driver 1", "Driver 2" and the totals
 * stay.
 */

export const DELIVERY_REPORT_SUBJECTS = [
	'deliveries',
	'driver_deliveries',
] as const
export type DeliveryReportSubject = (typeof DELIVERY_REPORT_SUBJECTS)[number]

export function isDeliveryReportSubject(
	subject: string,
): subject is DeliveryReportSubject {
	return DELIVERY_REPORT_SUBJECTS.some((item) => item === subject)
}

/** What a driver is called when the member may not see names. */
export function anonymousDriverLabel(ordinal: number): string {
	return `Driver ${ordinal}`
}

const locationFields: ReportField[] = [
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
		id: 'locationTimeZone',
		label: 'Location time zone',
		type: 'string',
		listable: false,
	},
]

const driverFields: ReportField[] = [
	{
		id: 'driver',
		label: 'Driver',
		type: 'string',
		filterable: true,
		groupable: true,
		description:
			'The driver’s name, for members who may see staff names. Everyone else sees Driver 1, Driver 2 and so on, and the totals stay.',
	},
	{
		id: 'driverKey',
		label: 'Driver id',
		type: 'string',
		filterable: true,
		groupable: true,
		listable: false,
	},
]

const currencyField: ReportField = {
	id: 'currency',
	label: 'Currency',
	type: 'string',
	filterable: true,
	groupable: true,
	listable: false,
}

const readyToPickedUp: ReportField = {
	id: 'minutesReadyToPickedUp',
	label: 'Minutes from ready to picked up',
	type: 'duration',
	sumLabel: false,
	averageLabel: 'Average minutes from ready to picked up',
	description: 'How long a ready order waited for its driver.',
}

const pickedUpToDelivered: ReportField = {
	id: 'minutesPickedUpToDelivered',
	label: 'Minutes from picked up to delivered',
	type: 'duration',
	sumLabel: false,
	averageLabel: 'Average minutes from picked up to delivered',
	description: 'The drive: from leaving with the order to handing it over.',
}

const deliveryFields: ReportField[] = [
	{
		id: 'deliveredAt',
		label: 'Delivered at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description:
			'When the delivery ended (handed over, or reported as a problem), in the location’s time zone.',
	},
	...driverFields,
	...locationFields,
	{
		id: 'zone',
		label: 'Zone',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'The delivery zone of the order. Never an address.',
	},
	{
		id: 'outcome',
		label: 'Outcome',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'delivered', label: 'Delivered' },
			{ value: 'problem', label: 'Problem reported' },
		],
	},
	{
		id: 'deliveries',
		label: 'Deliveries',
		type: 'number',
		sumLabel: 'Deliveries',
		averageLabel: false,
		description: 'Deliveries handed over. A stop with a problem is not one.',
	},
	readyToPickedUp,
	pickedUpToDelivered,
	{
		id: 'minutesActual',
		label: 'Minutes from placed to delivered',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average minutes from placed to delivered',
		description: 'The whole wait the guest had.',
	},
	{
		id: 'minutesPromised',
		label: 'Minutes promised',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average minutes promised',
		description:
			'From placed to the time promised to the guest (the end of the window when it is a range). Orders placed before promised times existed are left out.',
	},
	{
		id: 'minutesLate',
		label: 'Minutes late',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average minutes late (negative: early)',
		description: 'Delivered time against the time promised to the guest.',
	},
	{
		id: 'lateDeliveries',
		label: 'Late deliveries',
		type: 'number',
		sumLabel: 'Late deliveries',
		averageLabel: false,
		description: 'Deliveries handed over after the promised time.',
	},
	{
		id: 'promisedDeliveries',
		label: 'Deliveries with a promised time',
		type: 'number',
		sumLabel: 'Deliveries with a promised time',
		averageLabel: false,
		listable: false,
	},
	{
		id: 'lateRate',
		label: 'Late against promised',
		type: 'ratio',
		ratio: {
			numerator: 'lateDeliveries',
			denominator: 'promisedDeliveries',
			unit: 'percent',
		},
		description:
			'Share of deliveries with a promised time that were handed over late.',
	},
	{
		id: 'cashCollected',
		label: 'Cash collected',
		type: 'currency',
		sumLabel: 'Cash collected',
		averageLabel: false,
		description: 'What the driver says they collected on delivery.',
	},
	{
		id: 'tips',
		label: 'Tips',
		type: 'currency',
		sumLabel: 'Tips',
		averageLabel: 'Average tip',
		description: 'The tip on the order, attributed to the driver who delivered it.',
	},
	{
		id: 'problems',
		label: 'Problems reported',
		type: 'number',
		sumLabel: 'Problems reported',
		averageLabel: false,
	},
	{
		id: 'problemKind',
		label: 'Problem',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'none', label: 'No problem' },
			{ value: 'not_home', label: 'Nobody home' },
			{ value: 'wrong_address', label: 'Wrong address' },
			{ value: 'refused', label: 'Guest refused' },
			{ value: 'cannot_reach', label: 'Cannot reach the guest' },
			{ value: 'other', label: 'Other problem' },
		],
	},
	currencyField,
]

const driverSummaryFields: ReportField[] = [
	{
		id: 'periodEnd',
		label: 'Period end',
		type: 'datetime',
		timeframe: true,
		showTime: true,
		listable: false,
		description: 'The end of the period the figures cover.',
	},
	...driverFields,
	// Filterable only: the loader counts a driver's deliveries at the chosen
	// location itself (a record spans every location the driver worked).
	...locationFields.map((field) => ({ ...field, listable: false })),
	{
		id: 'deliveries',
		label: 'Deliveries',
		type: 'number',
		sumLabel: 'Deliveries',
		averageLabel: false,
	},
	{
		id: 'avgMinutesReadyToPickedUp',
		label: 'Ready to picked up (min)',
		type: 'number',
		sumLabel: false,
		averageLabel: false,
		description: 'Average minutes a ready order waited for this driver.',
	},
	{
		id: 'avgMinutesPickedUpToDelivered',
		label: 'Picked up to delivered (min)',
		type: 'number',
		sumLabel: false,
		averageLabel: false,
		description: 'Average minutes of the drive.',
	},
	{
		id: 'lateDeliveries',
		label: 'Late deliveries',
		type: 'number',
		sumLabel: 'Late deliveries',
		averageLabel: false,
	},
	{
		id: 'cashCollected',
		label: 'Cash collected',
		type: 'currency',
		sumLabel: 'Cash collected',
		averageLabel: false,
	},
	{
		id: 'tips',
		label: 'Tips',
		type: 'currency',
		sumLabel: 'Tips',
		averageLabel: false,
	},
	{
		id: 'problems',
		label: 'Problems reported',
		type: 'number',
		sumLabel: 'Problems reported',
		averageLabel: false,
	},
	currencyField,
]

export const deliveryReportSubjects: ReportSubject[] = [
	{
		id: 'deliveries',
		label: 'Deliveries',
		description:
			'Each delivery made by the restaurant’s own drivers: times from ready to picked up and picked up to delivered, against the promised time, with cash, tips and problems. Zones only, never an address.',
		scope: 'organization',
		source: 'tenant-api',
		fields: deliveryFields,
		currencyField: 'currency',
		splitCurrencies: true,
		timeZoneField: 'locationTimeZone',
		defaultColumns: [
			'deliveredAt',
			'driver',
			'zone',
			'minutesReadyToPickedUp',
			'minutesPickedUpToDelivered',
			'minutesLate',
			'cashCollected',
			'tips',
			'problemKind',
		],
	},
	{
		id: 'driver_deliveries',
		label: 'Deliveries by driver',
		description:
			'One row per driver for the period: deliveries, average minutes from ready to picked up and from picked up to delivered, late deliveries, cash collected, tips and problems. Each row opens that driver’s deliveries.',
		scope: 'organization',
		source: 'tenant-api',
		fields: driverSummaryFields,
		currencyField: 'currency',
		splitCurrencies: true,
		rowRefField: 'driverKey',
		listOrder: { field: 'deliveries', direction: 'desc' },
		// The loader narrows the deliveries each driver is counted on.
		loaderFilterFields: ['location', 'locationId'],
		defaultColumns: [
			'driver',
			'deliveries',
			'avgMinutesReadyToPickedUp',
			'avgMinutesPickedUpToDelivered',
			'lateDeliveries',
			'cashCollected',
			'tips',
			'problems',
		],
	},
]
