import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { translate } from '~/lib/translate'

/**
 * Translates a template while keeping its `{name}` placeholders so the client
 * can fill them later with `fillTemplate`.
 */
function keep(i18n: I18n, descriptor: MessageDescriptor, ...names: string[]) {
	return translate(
		i18n,
		descriptor,
		Object.fromEntries(names.map((name) => [name, `{${name}}`])),
	)
}

/** Every interface string the booking, manage and profile client modules show. */
export function buildReservationLabels(i18n: I18n) {
	const t = (descriptor: MessageDescriptor) => i18n._(descriptor)
	return {
		// Page shell
		pageTitle: t(msg`Reserve a table`),
		pageSubtitle: keep(i18n, msg`Book a table at {name}.`, 'name'),
		loading: t(msg`Loading…`),
		unavailableTitle: t(msg`Online booking is not available right now`),
		unavailableBody: t(msg`Please call the restaurant to book a table.`),
		noscript: t(
			msg`Online booking needs JavaScript. Please call the restaurant to book a table.`,
		),

		// Search step
		stepFind: t(msg`Find a table`),
		stepTime: t(msg`Choose a time`),
		stepDetails: t(msg`Your details`),
		fieldLocation: t(msg`Location`),
		fieldParty: t(msg`Party size`),
		fieldDate: t(msg`Date`),
		fieldTime: t(msg`Time`),
		findButton: t(msg`Find a table`),
		guestsOne: t(msg`1 guest`),
		guestsMany: keep(i18n, msg`{count} guests`, 'count'),
		largerParty: t(msg`Larger party`),
		restaurantZone: keep(
			i18n,
			msg`All times are in the restaurant's time zone: {zone}.`,
			'zone',
		),
		searching: t(msg`Looking for tables…`),

		// Results
		timesHeading: t(msg`Available times`),
		timesFor: keep(i18n, msg`{party} on {date}`, 'party', 'date'),
		noSlotsTitle: t(msg`No tables available for that search`),
		noSlotsBody: t(
			msg`Try one of these times or dates instead, or change your search.`,
		),
		closedDay: t(msg`The restaurant is closed on this date.`),
		onlineClosed: t(
			msg`Online booking is closed for this date. Please call the restaurant.`,
		),
		beyondHorizon: t(msg`That date is too far ahead to book online.`),
		sameDayHeading: t(msg`Other times that day`),
		otherDatesHeading: t(msg`Other dates with tables`),
		otherDateOption: keep(i18n, msg`{date} at {time}`, 'date', 'time'),
		selectTime: keep(i18n, msg`Book {time}`, 'time'),

		// Hold
		holdHeading: t(msg`Your table is held`),
		holdCountdown: keep(i18n, msg`Held for {time}`, 'time'),
		holdSummary: keep(
			i18n,
			msg`{party}, {date} at {time}`,
			'party',
			'date',
			'time',
		),
		holdExpiredTitle: t(msg`Your hold expired`),
		changeTime: t(msg`Change time`),
		back: t(msg`Back`),

		// Details form
		detailsHeading: t(msg`Your details`),
		firstName: t(msg`First name`),
		lastName: t(msg`Last name`),
		phone: t(msg`Phone`),
		phoneHint: keep(
			i18n,
			msg`Include your country code, for example {example}.`,
			'example',
		),
		email: t(msg`Email`),
		emailHint: t(msg`We send your confirmation here.`),
		optional: t(msg`(optional)`),
		occasion: t(msg`Occasion`),
		occasionNone: t(msg`No occasion`),
		dietary: t(msg`Dietary needs`),
		dietaryNotes: t(msg`Other dietary needs`),
		requests: t(msg`Special requests`),
		smsOptIn: t(msg`Text me reminders about this reservation`),
		marketingEmail: keep(
			i18n,
			msg`Email me news and offers from {name}`,
			'name',
		),
		marketingSms: keep(i18n, msg`Text me news and offers from {name}`, 'name'),
		contactNote: keep(
			i18n,
			msg`By booking, you agree that {name} may contact you about this reservation.`,
			'name',
		),
		signedInNote: t(msg`We filled in your details from your profile.`),
		submit: t(msg`Confirm reservation`),
		submitting: t(msg`Booking…`),
		fixFields: t(msg`Please check the fields marked below.`),
		fieldRequired: t(msg`This is required.`),
		phoneInvalid: keep(
			i18n,
			msg`Enter a phone number with its country code, like {example}.`,
			'example',
		),
		emailInvalid: t(msg`Enter a valid email address.`),
		verifyFirst: t(msg`Complete the verification check before booking.`),

		// Large parties
		largeContactTitle: keep(i18n, msg`Parties larger than {count}`, 'count'),
		largeContactBody: t(
			msg`For a larger party, please contact the restaurant directly.`,
		),
		largeCall: keep(i18n, msg`Call {phone}`, 'phone'),
		largeRequestTitle: keep(
			i18n,
			msg`Request a table for more than {count} guests`,
			'count',
		),
		largeRequestBody: t(
			msg`The restaurant reviews large-party requests and replies to confirm.`,
		),
		largeSubmit: t(msg`Send request`),

		// Confirmation
		confirmedTitle: t(msg`You are booked`),
		confirmedBody: t(msg`We sent a confirmation to your email or phone.`),
		requestedTitle: t(msg`Request received`),
		requestedBody: keep(
			i18n,
			msg`{name} will review your request and get back to you.`,
			'name',
		),
		confirmationCode: t(msg`Confirmation code`),
		addToCalendar: t(msg`Add to calendar`),
		manageLink: t(msg`Manage reservation`),
		saveLinkNote: t(
			msg`Keep the manage link. Anyone who has it can change or cancel this booking.`,
		),
		bookAnother: t(msg`Make another reservation`),
		whereLabel: t(msg`Where`),
		whenLabel: t(msg`When`),
		partyLabel: t(msg`Party`),

		// Statuses
		statusBooked: t(msg`Confirmed`),
		statusRequested: t(msg`Awaiting approval`),
		statusPendingPayment: t(msg`Awaiting payment`),
		statusArrived: t(msg`Arrived`),
		statusSeated: t(msg`Seated`),
		statusFinished: t(msg`Completed`),
		statusCancelled: t(msg`Cancelled`),
		statusDeclined: t(msg`Declined`),
		statusNoShow: t(msg`No-show`),
		statusExpired: t(msg`Expired`),

		// Manage
		manageTitle: t(msg`Your reservation`),
		manageNoToken: t(
			msg`Open the link from your confirmation to manage a reservation.`,
		),
		manageHello: keep(i18n, msg`Hello, {name}`, 'name'),
		modifyOpen: t(msg`Change time or party size`),
		modifySave: t(msg`Save changes`),
		modifySaved: t(msg`Your reservation was updated.`),
		modifyPickTime: t(msg`Choose a new time`),
		cancelOpen: t(msg`Cancel reservation`),
		cancelConfirmTitle: t(msg`Cancel this reservation?`),
		cancelConfirmYes: t(msg`Yes, cancel it`),
		cancelKeep: t(msg`Keep my reservation`),
		cancelledBody: t(msg`Your reservation has been cancelled.`),
		cancelDeadline: keep(i18n, msg`You can cancel until {time}.`, 'time'),
		confirmAttendance: t(msg`Confirm I am coming`),
		attendanceConfirmed: t(msg`Thanks. The restaurant knows you are coming.`),
		runningLate: t(msg`I am running late`),
		lateMinutes: keep(i18n, msg`{count} minutes late`, 'count'),
		lateSent: t(msg`We told the restaurant you are running late.`),
		lateStatus: keep(
			i18n,
			msg`You told us you are about {count} minutes late.`,
			'count',
		),
		contactHeading: t(msg`Contact`),
		occasionLabel: t(msg`Occasion`),
		requestsLabel: t(msg`Special requests`),
		dietaryLabel: t(msg`Dietary needs`),
		callRestaurant: keep(i18n, msg`Call {phone}`, 'phone'),

		// Profile panel
		upcomingTitle: t(msg`Upcoming reservations`),
		upcomingEmpty: t(msg`You have no upcoming reservations.`),
		upcomingLoadError: t(msg`We could not load your reservations.`),
		upcomingManage: t(msg`Manage`),
		upcomingBook: t(msg`Book a table`),

		// Block
		bookATable: t(msg`Book a table`),

		// Errors
		errorSlotUnavailable: t(
			msg`That time was just taken. Please choose another time.`,
		),
		errorHoldExpired: t(msg`Your hold expired. Please choose a time again.`),
		errorRateLimited: t(
			msg`Too many attempts. Please wait a moment and try again.`,
		),
		errorVerification: t(
			msg`The verification check did not pass. Please try again.`,
		),
		errorPaused: t(
			msg`Online booking is paused right now. Please call the restaurant.`,
		),
		errorNotFound: t(
			msg`We could not find that reservation. The link may have expired.`,
		),
		errorPhoneOverlap: t(
			msg`This phone number already has a reservation at that time.`,
		),
		errorPhoneLimit: t(
			msg`This phone number has too many upcoming reservations.`,
		),
		errorCancelClosed: t(
			msg`It is too late to cancel online. Please call the restaurant.`,
		),
		errorModifyClosed: t(
			msg`It is too late to change this online. Please call the restaurant.`,
		),
		errorLargeParty: t(
			msg`That party size needs a request. Please use the large-party option.`,
		),
		errorRequestsClosed: t(
			msg`The restaurant is not taking requests for that date.`,
		),
		errorPartySize: t(msg`That party size is not available online.`),
		errorInvalid: t(msg`Please check your details and try again.`),
		errorNetwork: t(
			msg`We could not reach the server. Check your connection and try again.`,
		),
		errorGeneric: t(msg`Something went wrong. Please try again.`),
	}
}

export type ReservationLabels = ReturnType<typeof buildReservationLabels>
export type ReservationLabelKey = keyof ReservationLabels
