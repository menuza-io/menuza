import Foundation

// Decodable models for the public `/reservations/*` contract. The canonical
// fixtures in `packages/reservations/contract-fixtures` (copied to
// `Tests/TenantKitTests/Fixtures/Reservations`) are decoded by the tests, and
// `docs/reservations-contract.md` describes every field.
//
// Statuses stay strings so a value added by a newer server never breaks an
// older app; the helpers below name the ones the app acts on.

// MARK: - Clock

/// Server timestamps are ISO-8601 with milliseconds (`2030-06-14T16:00:00.000Z`).
public enum ReservationClock {
	public static func parse(_ value: String) -> Date? {
		let withFraction = ISO8601DateFormatter()
		withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let date = withFraction.date(from: value) { return date }
		let plain = ISO8601DateFormatter()
		plain.formatOptions = [.withInternetDateTime]
		return plain.date(from: value)
	}

	/// "19:30" for minutes after local midnight; values past 24:00 wrap (late-night slots).
	public static func timeLabel(localMin: Int) -> String {
		let minutes = ((localMin % 1440) + 1440) % 1440
		return String(format: "%02d:%02d", minutes / 60, minutes % 60)
	}
}

// MARK: - Config

public struct ReservationChip: Decodable, Equatable, Sendable, Identifiable {
	public let id: String
	public let name: String
}

public struct ReservationArea: Decodable, Equatable, Sendable, Identifiable {
	public let id: String
	public let name: String
}

public struct ReservationAddress: Decodable, Equatable, Sendable {
	public let formattedAddress: String
	public let city: String?
}

public struct ReservationPartyRange: Decodable, Equatable, Sendable {
	public let min: Int
	public let max: Int

	public init(min: Int, max: Int) {
		self.min = min
		self.max = max
	}
}

public struct ReservationContact: Decodable, Equatable, Sendable {
	public let name: String
	public let phone: String?
}

public struct ReservationLargeParty: Decodable, Equatable, Sendable {
	/// `request` (the guest sends a request) or `contact` (call the restaurant).
	public let mode: String
	public let maxOnlinePartySize: Int
	public let phone: String?
	public let contact: ReservationContact
	public let note: String?

	public var acceptsRequests: Bool { mode == "request" }
}

public struct ReservationWaitlistFlags: Decodable, Equatable, Sendable {
	public let enabled: Bool
	public let online: Bool
}

public struct ReservationLocation: Decodable, Equatable, Sendable, Identifiable {
	public let id: String
	public let name: String
	public let address: ReservationAddress?
	public let timeZone: String
	public let phone: String?
	public let partySize: ReservationPartyRange
	public let horizonDays: Int
	public let intervalMin: Int
	public let holdMinutes: Int
	public let largeParty: ReservationLargeParty
	public let waitlist: ReservationWaitlistFlags
	public let notifyMe: Bool
	public let areas: [ReservationArea]
	public let publicNote: String?
}

public struct ReservationsOrganization: Decodable, Equatable, Sendable {
	public let name: String
	public let defaultLocale: String
}

public struct ReservationsConfig: Decodable, Equatable, Sendable {
	public let organization: ReservationsOrganization
	public let locations: [ReservationLocation]
	public let occasions: [ReservationChip]
	public let dietary: [ReservationChip]
	public let now: String
}

// MARK: - Availability

public struct ReservationSlot: Decodable, Equatable, Sendable, Hashable {
	public let localMin: Int
	public let time: String
	public let serviceId: String?
	public let serviceName: String?
	public let areaId: String?
	public let areaLabel: String?

	public init(
		localMin: Int,
		time: String? = nil,
		serviceId: String? = nil,
		serviceName: String? = nil,
		areaId: String? = nil,
		areaLabel: String? = nil
	) {
		self.localMin = localMin
		self.time = time ?? ReservationClock.timeLabel(localMin: localMin)
		self.serviceId = serviceId
		self.serviceName = serviceName
		self.areaId = areaId
		self.areaLabel = areaLabel
	}
}

public struct ReservationAlternativeDate: Decodable, Equatable, Sendable, Hashable {
	public let date: String
	public let firstLocalMin: Int
}

public struct ReservationAlternatives: Decodable, Equatable, Sendable {
	public let sameDay: [ReservationSlot]
	public let otherDates: [ReservationAlternativeDate]

	public static let none = ReservationAlternatives(sameDay: [], otherDates: [])

	public init(sameDay: [ReservationSlot], otherDates: [ReservationAlternativeDate]) {
		self.sameDay = sameDay
		self.otherDates = otherDates
	}

	public var isEmpty: Bool { sameDay.isEmpty && otherDates.isEmpty }
}

public struct ReservationClosedInfo: Decodable, Equatable, Sendable {
	public let reason: String?
	public let note: String?
	public let name: String?
}

public struct ReservationAvailability: Decodable, Equatable, Sendable {
	public let dayVersion: Int
	public let settingsVersion: Int
	public let timeZone: String
	public let now: String
	public let locationId: String
	public let date: String
	public let partySize: Int
	/// `available`, `full`, `closed`, `online_closed`, `beyond_horizon` or `large_party`.
	public let status: String
	public let slots: [ReservationSlot]
	public let alternatives: ReservationAlternatives
	public let largeParty: ReservationLargeParty?
	public let closed: ReservationClosedInfo?
	public let onlineClosed: ReservationClosedInfo?
	public let notifyMe: Bool
	public let waitlist: Bool

	public var hasSlots: Bool { !slots.isEmpty }
	public var isLargeParty: Bool { status == "large_party" }
}

public struct ReservationCalendarDay: Decodable, Equatable, Sendable, Identifiable {
	public let date: String
	public let hasAvailability: Bool
	public let status: String
	public let closed: Bool
	public let slotCount: Int
	public let firstLocalMin: Int?
	public let lastLocalMin: Int?

	public var id: String { date }
}

public struct ReservationCalendar: Decodable, Equatable, Sendable {
	public let locationId: String
	public let timeZone: String
	public let now: String
	public let partySize: Int
	public let days: [ReservationCalendarDay]
}

// MARK: - Holds

public struct ReservationPolicy: Decodable, Equatable, Sendable {
	public let kind: String
	/// `deposit`, `prepay`, `experience` or `guarantee`.
	public let purpose: String
	public let termsVersion: Int
	public let terms: String?
	public let amountMinor: Int
	public let totalAmountMinor: Int
	public let perCover: Bool
	public let currency: String
	public let freeCancelUntilMin: Int
	public let lateCancelFeeMinor: Int
	public let noShowFeeMinor: Int
}

public struct ReservationHeldSlot: Decodable, Equatable, Sendable {
	public let date: String
	public let localMin: Int
	public let partySize: Int
	public let serviceId: String?
}

public struct ReservationHold: Decodable, Equatable, Sendable {
	/// A secret capability: held in memory for the booking, never logged.
	public let holdToken: String
	public let expiresAt: String
	public let now: String
	public let locationId: String
	public let slot: ReservationHeldSlot
	public let experienceId: String?
	public let requiresPayment: Bool?
	public let policy: ReservationPolicy?
}

// MARK: - Reservations

public struct ReservationSummary: Decodable, Equatable, Sendable, Identifiable {
	public let id: String
	public let confirmationCode: String
	public let status: String
	public let channel: String
	public let locationId: String
	public let locationName: String?
	public let date: String
	public let localMin: Int
	public let time: String
	public let startAt: String
	public let endAt: String
	public let partySize: Int
	public let timeZone: String
	public let paymentStatus: String?
	public let paymentExpiresAt: String?
}

public struct ReservationPaymentBlock: Decodable, Equatable, Sendable {
	/// Authorizes the status poll for this booking only; never logged.
	public let paymentToken: String
	public let purpose: String
	public let amountMinor: Int
	public let currency: String
	public let expiresAt: String
	/// Opened in the system browser. It carries the token in the URL fragment.
	public let payUrl: String
}

public struct ReservationBooking: Decodable, Equatable, Sendable {
	public let reservation: ReservationSummary
	/// The capability for manage calls. Stored in the Keychain, never logged.
	public let manageToken: String
	public let payment: ReservationPaymentBlock?
}

public struct ReservationManageLocation: Decodable, Equatable, Sendable {
	public let id: String
	public let name: String?
	public let address: String?
	public let phone: String?
	public let timeZone: String
}

public struct ReservationOccasion: Decodable, Equatable, Sendable {
	public let id: String
	public let name: String
}

public struct ReservationManageDetails: Decodable, Equatable, Sendable {
	public let id: String
	public let confirmationCode: String
	public let status: String
	public let channel: String
	public let locationId: String
	public let locationName: String?
	public let date: String
	public let localMin: Int
	public let time: String
	public let startAt: String
	public let endAt: String
	public let partySize: Int
	public let timeZone: String
	public let firstName: String?
	public let occasion: ReservationOccasion?
	public let requests: String?
	public let dietary: String?
	public let runningLateMin: Int?
	public let smsOptIn: Bool
	public let location: ReservationManageLocation
}

public struct ReservationMaskedContact: Decodable, Equatable, Sendable {
	public let phone: String?
	public let email: String?
}

public struct ReservationManagePolicy: Decodable, Equatable, Sendable {
	public let kind: String
	public let terms: String?
	public let freeCancelUntilMin: Int
	public let currency: String
}

public struct ReservationManageView: Decodable, Equatable, Sendable {
	public let now: String
	public let reservation: ReservationManageDetails
	public let status: String
	public let firstName: String?
	public let contact: ReservationMaskedContact
	public let policy: ReservationManagePolicy?
	public let paymentStatus: String
	public let canModify: Bool
	public let canCancel: Bool
	public let cancelDeadline: String?

	/// Running late only makes sense for a live booking, up to its start time.
	public var canRunLate: Bool {
		guard ["booked", "confirmed"].contains(status) else { return false }
		guard
			let startAt = ReservationClock.parse(reservation.startAt),
			let now = ReservationClock.parse(now)
		else { return false }
		return now < startAt.addingTimeInterval(30 * 60)
	}
}

public struct ReservationMineEntry: Decodable, Equatable, Sendable, Identifiable {
	public let id: String
	public let confirmationCode: String
	public let status: String
	public let channel: String
	public let locationId: String
	public let locationName: String?
	public let date: String
	public let localMin: Int
	public let time: String
	public let startAt: String
	public let endAt: String
	public let partySize: Int
	public let timeZone: String
	public let manageToken: String
}

public struct ReservationMine: Decodable, Equatable, Sendable {
	public let now: String
	public let upcoming: [ReservationMineEntry]
	public let past: [ReservationMineEntry]
}

// MARK: - Payment status

/// `GET /reservations/manage/payment`: exactly these three fields.
public struct ReservationPaymentStatus: Decodable, Equatable, Sendable {
	public let paymentStatus: String
	public let reservationStatus: String
	public let now: String

	public init(paymentStatus: String, reservationStatus: String, now: String) {
		self.paymentStatus = paymentStatus
		self.reservationStatus = reservationStatus
		self.now = now
	}
}

/// What the guest sees for a payment status answer. Mirrors `interpretPay` in
/// Sites (`apps/sites/src/lib/reservations/pay.ts`): only a status answer can say
/// "paid"; a redirect back from the provider never does.
public enum ReservationPaymentOutcome: Equatable, Sendable {
	case paid
	case expired
	case failed
	case review
	case refunded
	case pending

	private static let paidStatuses: Set<String> = ["paid", "guaranteed", "fee_charged"]
	private static let deadStatuses: Set<String> = [
		"cancelled", "expired", "declined", "no_show", "finished",
	]

	public static func interpret(_ status: ReservationPaymentStatus) -> ReservationPaymentOutcome {
		if paidStatuses.contains(status.paymentStatus) { return .paid }
		if status.paymentStatus == "fee_failed" { return .failed }
		if status.paymentStatus == "review" || status.paymentStatus == "disputed" { return .review }
		if ["refunded", "partially_refunded", "refund_pending"].contains(status.paymentStatus) {
			return .refunded
		}
		if deadStatuses.contains(status.reservationStatus) { return .expired }
		return .pending
	}

	/// The poll stops on every outcome except `pending`.
	public var isFinal: Bool { self != .pending }
}

// MARK: - Waitlist

public struct ReservationWaitlistEntry: Decodable, Equatable, Sendable {
	public let id: String
	public let locationId: String
	public let locationName: String?
	public let status: String
	public let position: Int?
	public let partySize: Int
	public let quotedMin: Int?
	public let quotedReadyAt: String?
}

public struct ReservationWaitlistJoin: Decodable, Equatable, Sendable {
	public let entry: ReservationWaitlistEntry
	/// The capability for the status link. Stored in the Keychain, never logged.
	public let statusToken: String
	public let now: String
}

public struct ReservationWaitlistStatus: Decodable, Equatable, Sendable {
	/// `waiting`, `notified`, `on_the_way`, `seated`, `left`, ... (see the contract).
	public let status: String
	public let position: Int?
	public let partySize: Int
	public let quotedMin: Int?
	public let quotedReadyAt: String?
	public let locationName: String?
	public let notifiedAt: String?
	public let responseDeadlineAt: String?
	public let canLeave: Bool
	public let canOnMyWay: Bool
	public let now: String
}

// MARK: - Errors

/// A non-2xx answer from `/reservations/*`: a stable `error` code, an optional
/// `reason` (for `rate_limited`) and, for `slot_unavailable`, alternatives.
/// Never carries a request value; the server does not echo any.
public struct ReservationAPIError: Error, Equatable, LocalizedError, Sendable {
	public let statusCode: Int
	public let code: String
	public let reason: String?
	public let alternatives: ReservationAlternatives?

	public init(
		statusCode: Int,
		code: String,
		reason: String? = nil,
		alternatives: ReservationAlternatives? = nil
	) {
		self.statusCode = statusCode
		self.code = code
		self.reason = reason
		self.alternatives = alternatives
	}

	public var errorDescription: String? { code }

	private struct Body: Decodable {
		let error: String?
		let reason: String?
		let alternatives: ReservationAlternatives?
	}

	public static func from(statusCode: Int, data: Data) -> ReservationAPIError {
		let body = try? JSONDecoder().decode(Body.self, from: data)
		return ReservationAPIError(
			statusCode: statusCode,
			code: body?.error ?? "error",
			reason: body?.reason,
			alternatives: body?.alternatives
		)
	}
}

// MARK: - Request values

/// What the guest typed for one booking. The phone is the signed-in customer's
/// verified number (from `/auth/me`); the app never shows a phone field.
public struct ReservationGuestDetails: Equatable, Sendable {
	public var firstName: String
	public var lastName: String
	public var phone: String
	public var email: String
	public var occasionTagId: String?
	public var requests: String
	public var dietary: String
	public var areaId: String?
	public var smsOptIn: Bool
	public var locale: String
	/// Set once the guest ticks the consent box for a payment policy.
	public var policyTermsVersion: String?

	public init(
		firstName: String = "",
		lastName: String = "",
		phone: String = "",
		email: String = "",
		occasionTagId: String? = nil,
		requests: String = "",
		dietary: String = "",
		areaId: String? = nil,
		smsOptIn: Bool = false,
		locale: String = "en",
		policyTermsVersion: String? = nil
	) {
		self.firstName = firstName
		self.lastName = lastName
		self.phone = phone
		self.email = email
		self.occasionTagId = occasionTagId
		self.requests = requests
		self.dietary = dietary
		self.areaId = areaId
		self.smsOptIn = smsOptIn
		self.locale = locale
		self.policyTermsVersion = policyTermsVersion
	}
}

public extension ReservationLocation {
	/// The most a guest can step to. Above `partySize.max` the booking is a
	/// large-party request or a call (see `largeParty.mode`); only a location that
	/// turned large parties off stops at the online maximum. 99 is the API limit.
	static let largePartyCeiling = 99

	var partyCeiling: Int {
		largeParty.mode == "disabled" ? partySize.max : max(partySize.max, Self.largePartyCeiling)
	}

	/// True when `size` is above the online maximum and a request is possible.
	func needsApproval(partySize size: Int) -> Bool {
		size > partySize.max && largeParty.mode != "disabled"
	}
}
