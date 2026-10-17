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
]
