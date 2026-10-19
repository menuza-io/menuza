import { type ReportField, type ReportSubject } from './catalog.ts'

/**
 * Reservations report subjects. They read the regional tenant database in
 * tenant-api and are restricted subjects: a token lists them only when the
 * Reservations module is on and the person holds `read:reservation_report:any`
 * (see `operator-token.ts`).
 *
 * Rows describe a booking or a waitlist entry as aggregate facts only. No field
 * exposes a guest's name, phone, email, notes, allergy text or any other
 * contact detail, so a report can be shared without carrying guest PII.
 */
export const RESERVATIONS_REPORT_SUBJECTS = [
	'bookings',
	'waitlist_entries',
	'pacing_slots',
] as const
export type ReservationsReportSubject =
	(typeof RESERVATIONS_REPORT_SUBJECTS)[number]

/** Whether `subject` is one of the loadable Reservations subjects. */
export function isReservationsReportSubject(
	subject: string,
): subject is ReservationsReportSubject {
	return RESERVATIONS_REPORT_SUBJECTS.some((item) => item === subject)
}

const locationField: ReportField = {
	id: 'location',
	label: 'Location',
	type: 'string',
	filterable: true,
	groupable: true,
}

const timeZoneField: ReportField = {
	id: 'timeZone',
	label: 'Time zone',
	type: 'string',
	listable: false,
}

const businessDateField: ReportField = {
	id: 'businessDate',
	label: 'Business date',
	type: 'string',
	filterable: true,
	groupable: true,
	description:
		'The restaurant’s service day (YYYY-MM-DD) in the location’s time zone.',
}

const BOOKED_NOTE = 'Booked means not cancelled, declined or expired.'

/** A 0/1 number per booking. Summed it counts; divided it makes a rate. */
function flagField(
	id: string,
	label: string,
	sumLabel: string,
	description: string,
): ReportField {
	return {
		id,
		label,
		type: 'number',
		filterable: true,
		listable: false,
		sumLabel,
		averageLabel: false,
		description,
	}
}

const bookingFields: ReportField[] = [
	{
		id: 'startsAt',
		label: 'Starts at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description: 'When the booking starts, in the location’s time zone.',
	},
	businessDateField,
	locationField,
	{
		id: 'service',
		label: 'Service',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'experience',
		label: 'Experience',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'partySize',
		label: 'Party size',
		type: 'number',
		filterable: true,
		groupable: true,
		sumLabel: 'Booked covers',
		averageLabel: 'Average party size',
	},
	{
		id: 'covers',
		label: 'Covers',
		type: 'number',
		description:
			'Guests who actually came when known, otherwise the booked party size.',
		sumLabel: 'Covers',
		averageLabel: 'Average covers per booking',
	},
	{
		id: 'status',
		label: 'Status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'pending_payment', label: 'Pending payment' },
			{ value: 'pending_approval', label: 'Pending approval' },
			{ value: 'booked', label: 'Booked' },
			{ value: 'confirmed', label: 'Confirmed' },
			{ value: 'arrived', label: 'Arrived' },
			{ value: 'partially_seated', label: 'Partially seated' },
			{ value: 'seated', label: 'Seated' },
			{ value: 'finished', label: 'Finished' },
			{ value: 'cancelled', label: 'Cancelled' },
			{ value: 'no_show', label: 'No-show' },
			{ value: 'declined', label: 'Declined' },
			{ value: 'expired', label: 'Expired' },
			{ value: 'disputed', label: 'Disputed' },
		],
	},
	{
		id: 'channel',
		label: 'Channel',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'online', label: 'Online' },
			{ value: 'native', label: 'Mobile app' },
			{ value: 'voice_agent', label: 'Phone agent' },
			{ value: 'phone', label: 'Phone' },
			{ value: 'host', label: 'Host' },
			{ value: 'walk_in', label: 'Walk-in' },
			{ value: 'waitlist', label: 'Waitlist' },
		],
	},
	{
		id: 'durationMinutes',
		label: 'Configured duration',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average configured duration',
	},
	{
		id: 'actualMinutes',
		label: 'Actual turn time',
		type: 'duration',
		description: 'From seated to finished. Empty until the party has left.',
		sumLabel: false,
		averageLabel: 'Average actual turn time',
	},
	{
		id: 'lateCancel',
		label: 'Late cancellation',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'Cancelled after the free-cancellation window closed.',
	},
	{
		id: 'cancelledBy',
		label: 'Cancelled by',
		type: 'enum',
		filterable: true,
		groupable: true,
		description:
			'Who cancelled the booking. Empty for bookings never cancelled.',
		options: [
			{ value: 'guest', label: 'Guest' },
			{ value: 'restaurant', label: 'Restaurant' },
			{ value: 'system', label: 'System' },
			{ value: 'unknown', label: 'Unknown' },
		],
	},
	{
		id: 'slotTime',
		label: 'Start time',
		type: 'string',
		filterable: true,
		groupable: true,
		description:
			'The booking’s start time of day (HH:MM) in the location’s zone.',
	},
	flagField('isBooked', 'Booked', 'Booked parties', BOOKED_NOTE),
	flagField('isNoShow', 'No-show', 'No-shows', 'Counts 1 for a no-show.'),
	flagField(
		'isCancelled',
		'Cancelled',
		'Cancellations',
		'Counts 1 for a cancelled booking.',
	),
	flagField(
		'isLateCancel',
		'Late cancelled',
		'Late cancellations',
		'Counts 1 for a booking cancelled after the free-cancellation window.',
	),
	flagField(
		'isFinished',
		'Finished',
		'Finished parties',
		'Counts 1 for a party that was seated and has left.',
	),
	{
		id: 'bookingCount',
		label: 'Bookings',
		type: 'number',
		listable: false,
		sumLabel: 'Bookings',
		averageLabel: false,
		description: 'Counts 1 for every booking, whatever its status.',
	},
	{
		id: 'noShowRate',
		label: 'No-show rate',
		type: 'ratio',
		listable: false,
		description: `No-shows as a share of booked parties. ${BOOKED_NOTE} Upcoming bookings count as booked, so use a date range that has passed.`,
		ratio: { numerator: 'isNoShow', denominator: 'isBooked', unit: 'percent' },
	},
	{
		id: 'cancellationRate',
		label: 'Cancellation rate',
		type: 'ratio',
		listable: false,
		description: 'Cancelled bookings as a share of all bookings.',
		ratio: {
			numerator: 'isCancelled',
			denominator: 'bookingCount',
			unit: 'percent',
		},
	},
	{
		id: 'lateCancelShare',
		label: 'Late cancellation share',
		type: 'ratio',
		listable: false,
		description: 'Late cancellations as a share of cancelled bookings.',
		ratio: {
			numerator: 'isLateCancel',
			denominator: 'isCancelled',
			unit: 'percent',
		},
	},
	{
		id: 'configuredTurnMinutes',
		label: 'Configured turn time',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average configured turn time',
		description:
			'The turn time the restaurant set for this party size, service and day. Empty when no rule applies.',
	},
	{
		id: 'turnVarianceMinutes',
		label: 'Difference from configured turn time',
		type: 'number',
		sumLabel: false,
		averageLabel: 'Average difference from configured turn time',
		description:
			'Actual turn time minus the configured one, in minutes. Negative means the party left early. Empty until the party has left or when no rule applies.',
	},
	{
		id: 'paymentStatus',
		label: 'Payment status',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'none', label: 'None' },
			{ value: 'pending', label: 'Pending' },
			{ value: 'guaranteed', label: 'Card on file' },
			{ value: 'paid', label: 'Paid' },
			{ value: 'refund_pending', label: 'Refund pending' },
			{ value: 'refunded', label: 'Refunded' },
			{ value: 'partially_refunded', label: 'Partially refunded' },
			{ value: 'fee_pending', label: 'Fee pending' },
			{ value: 'fee_charged', label: 'Fee charged' },
			{ value: 'fee_failed', label: 'Fee failed' },
			{ value: 'review', label: 'Needs review' },
			{ value: 'disputed', label: 'Disputed' },
		],
	},
	{
		id: 'collectedMinor',
		label: 'Deposits and fees collected',
		type: 'currency',
		sumLabel: 'Deposits and fees collected',
		averageLabel: 'Average collected per booking',
	},
	{
		id: 'refundedMinor',
		label: 'Refunded',
		type: 'currency',
		sumLabel: 'Refunded',
		averageLabel: 'Average refund per booking',
	},
	{
		id: 'currency',
		label: 'Currency',
		type: 'enum',
		filterable: true,
		groupable: true,
		listable: false,
	},
	timeZoneField,
]

const waitlistFields: ReportField[] = [
	{
		id: 'joinedAt',
		label: 'Joined at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description: 'When the party joined the waitlist, in the location’s zone.',
	},
	businessDateField,
	locationField,
	{
		id: 'partySize',
		label: 'Party size',
		type: 'number',
		filterable: true,
		groupable: true,
		sumLabel: 'Waiting covers',
		averageLabel: 'Average party size',
	},
	{
		id: 'channel',
		label: 'Channel',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'walk_in', label: 'Walk-in' },
			{ value: 'remote', label: 'Remote' },
		],
	},
	{
		id: 'status',
		label: 'Outcome',
		type: 'enum',
		filterable: true,
		groupable: true,
		options: [
			{ value: 'waiting', label: 'Waiting' },
			{ value: 'notified', label: 'Notified' },
			{ value: 'on_the_way', label: 'On the way' },
			{ value: 'seated', label: 'Seated' },
			{ value: 'cancelled', label: 'Cancelled' },
			{ value: 'left', label: 'Left' },
			{ value: 'no_response', label: 'No response' },
		],
	},
	{
		id: 'quotedMinutes',
		label: 'Quoted wait',
		type: 'duration',
		sumLabel: false,
		averageLabel: 'Average quoted wait',
	},
	{
		id: 'actualMinutes',
		label: 'Actual wait',
		type: 'duration',
		description:
			'From joining to being seated. Empty for parties never seated.',
		sumLabel: false,
		averageLabel: 'Average actual wait',
	},
	timeZoneField,
]

const pacingFields: ReportField[] = [
	{
		id: 'startsAt',
		label: 'Slot starts at',
		type: 'datetime',
		timeframe: true,
		groupable: true,
		showTime: true,
		description: 'The start of the slot, in the location’s time zone.',
	},
	businessDateField,
	locationField,
	{
		id: 'service',
		label: 'Service',
		type: 'string',
		filterable: true,
		groupable: true,
	},
	{
		id: 'slotTime',
		label: 'Slot',
		type: 'string',
		filterable: true,
		groupable: true,
		description: 'The slot’s start time of day (HH:MM).',
	},
	{
		id: 'bookings',
		label: 'Bookings',
		type: 'number',
		sumLabel: 'Bookings',
		averageLabel: 'Average bookings per slot',
	},
	{
		id: 'covers',
		label: 'Covers',
		type: 'number',
		sumLabel: 'Covers',
		averageLabel: 'Average covers per slot',
	},
	{
		id: 'maxCovers',
		label: 'Covers limit',
		type: 'number',
		sumLabel: false,
		averageLabel: 'Average covers limit',
		description:
			'The pacing limit on covers for the slot. Empty when none is set.',
	},
	{
		id: 'maxParties',
		label: 'Bookings limit',
		type: 'number',
		sumLabel: false,
		averageLabel: 'Average bookings limit',
		description:
			'The pacing limit on bookings for the slot. Empty when none is set.',
	},
	{
		id: 'overLimit',
		label: 'Over limit',
		type: 'boolean',
		filterable: true,
		groupable: true,
		description: 'The slot has more covers or bookings than its pacing limit.',
	},
	{
		id: 'slotCount',
		label: 'Slots',
		type: 'number',
		listable: false,
		sumLabel: 'Slots',
		averageLabel: false,
		description: 'Counts 1 for every slot.',
	},
	{
		id: 'overLimitSlots',
		label: 'Slots over limit',
		type: 'number',
		listable: false,
		sumLabel: 'Slots over limit',
		averageLabel: false,
		description: 'Counts 1 for a slot over its pacing limit.',
	},
	{
		id: 'coversUtilization',
		label: 'Covers against limit',
		type: 'ratio',
		listable: false,
		description:
			'Covers as a share of the covers limit. Slots with no covers limit are left out.',
		ratio: { numerator: 'covers', denominator: 'maxCovers', unit: 'percent' },
	},
	{
		id: 'overLimitShare',
		label: 'Share of slots over limit',
		type: 'ratio',
		listable: false,
		ratio: {
			numerator: 'overLimitSlots',
			denominator: 'slotCount',
			unit: 'percent',
		},
	},
	timeZoneField,
]

export const reservationsSubjects: ReportSubject[] = [
	{
		id: 'bookings',
		label: 'Bookings',
		description:
			'One row per reservation: date, service, party size, status and channel. No guest contact details. Needs reservation report access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: bookingFields,
		currencyField: 'currency',
		timeZoneField: 'timeZone',
		defaultColumns: [
			'startsAt',
			'location',
			'service',
			'partySize',
			'status',
			'channel',
		],
	},
	{
		id: 'waitlist_entries',
		label: 'Waitlist entries',
		description:
			'One row per waitlist party: size, quoted and actual wait, outcome. No guest contact details. Needs reservation report access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: waitlistFields,
		timeZoneField: 'timeZone',
		defaultColumns: [
			'joinedAt',
			'location',
			'partySize',
			'quotedMinutes',
			'actualMinutes',
			'status',
		],
	},
	{
		id: 'pacing_slots',
		label: 'Pacing slots',
		description:
			'One row per date, service and start time: bookings and covers against the pacing limit. No guest contact details. Needs reservation report access.',
		scope: 'organization',
		source: 'tenant-api',
		fields: pacingFields,
		timeZoneField: 'timeZone',
		defaultColumns: [
			'startsAt',
			'location',
			'service',
			'bookings',
			'covers',
			'maxCovers',
			'overLimit',
		],
	},
]
