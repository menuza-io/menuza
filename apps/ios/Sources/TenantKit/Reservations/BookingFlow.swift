import Foundation

// The pure booking state machine behind the SwiftUI screens (and mirrored by
// `core/reservations/BookingFlow.kt` on Android). It performs no I/O: the view
// layer calls `ReservationsClient`, then feeds each answer into the flow, so
// every transition is unit-tested on Linux.
//
//   idle -> searching -> choosingTime -> holding -> details -> reviewing
//        -> submitting -> confirmed | requested | awaitingPayment
//   awaitingPayment -> confirmed | expired | failed   (status poll)
//   details | reviewing -> expired                    (hold countdown reaches zero)
//   any -> failed(BookingFailure)                     (a mapped server error)

/// A fresh `Idempotency-Key`: matches the server's `[A-Za-z0-9._:-]{8,128}`.
public enum IdempotencyKey {
	public static func make() -> String { UUID().uuidString.lowercased() }
}

// MARK: - Failures

/// The failures the screens show a message for, mapped from the stable server
/// codes (see `docs/reservations-contract.md`). Never holds a request value.
public enum BookingFailure: Equatable, Sendable {
	/// 409 `slot_unavailable`; alternatives come from the answer.
	case slotUnavailable(ReservationAlternatives)
	/// 410 `hold_expired` (or an unknown hold token).
	case holdExpired
	/// 400 `policy_required`: the payment policy was not accepted.
	case policyRequired
	/// 422-style payment setup problems (`policy_unavailable`).
	case paymentUnavailable
	/// 429 `rate_limited`; `reason` is `phone_active_limit` when the guest has too many bookings.
	case rateLimited(reason: String?)
	/// 401, 403 or `verification_failed`: sign in again.
	case signInRequired
	case phoneOverlap
	case partySizeInvalid
	case invalid
	case largePartyOnly
	case requestsClosed
	/// 503 `unavailable`: online booking is paused.
	case paused
	case notFound
	case alreadyOnWaitlist
	case waitlistFull
	case idempotencyConflict
	case paymentFailed
	case paymentRefunded
	/// Offline or timed out; the booking may or may not have been recorded, so a
	/// retry reuses the same `Idempotency-Key`.
	case offline
	case generic

	public static func map(_ error: Error) -> BookingFailure {
		if let error = error as? ReservationAPIError {
			switch error.code {
			case "slot_unavailable": return .slotUnavailable(error.alternatives ?? .none)
			case "hold_expired": return .holdExpired
			case "policy_required": return .policyRequired
			case "policy_unavailable": return .paymentUnavailable
			case "rate_limited": return .rateLimited(reason: error.reason)
			case "verification_failed", "forbidden", "unauthorized": return .signInRequired
			case "phone_overlap": return .phoneOverlap
			case "party_size_invalid": return .partySizeInvalid
			case "invalid": return .invalid
			case "large_party": return .largePartyOnly
			case "requests_closed": return .requestsClosed
			case "unavailable": return .paused
			case "already_on_waitlist": return .alreadyOnWaitlist
			case "waitlist_full": return .waitlistFull
			case "idempotency_conflict": return .idempotencyConflict
			case "not_found": return .notFound
			default: break
			}
			switch error.statusCode {
			case 410: return .holdExpired
			case 429: return .rateLimited(reason: error.reason)
			case 503: return .paused
			case 404: return .notFound
			case 401, 403: return .signInRequired
			default: return .generic
			}
		}
		if let error = error as? APIError {
			if error.isTransportFailure { return .offline }
			if error.isUnauthorized || error.statusCode == 403 { return .signInRequired }
			if error.isRateLimited { return .rateLimited(reason: nil) }
			if error.isNotFound { return .notFound }
			return .generic
		}
		return .offline
	}

	/// A retry of the same request makes sense (and must reuse the idempotency key).
	public var isRetryableWithSameKey: Bool {
		switch self {
		case .offline, .paused: return true
		case .rateLimited(let reason): return reason != "phone_active_limit"
		case .generic: return true
		default: return false
		}
	}
}

// MARK: - Hold and clock

/// A hold with its countdown pinned to the server's clock: the deadline is
/// `expiresAt` on the server timeline, so a device clock that is minutes off
/// still expires the hold at the right moment.
public struct ActiveHold: Equatable, Sendable {
	public let token: String
	public let locationId: String
	public let date: String
	public let localMin: Int
	public let partySize: Int
	public let serviceId: String?
	public let expiresAt: Date
	/// Server time minus device time when the hold answer arrived.
	public let clockOffset: TimeInterval
	public let requiresPayment: Bool
	public let policy: ReservationPolicy?

	/// Seconds left on the server timeline (never negative).
	public func remaining(deviceNow: Date) -> TimeInterval {
		max(0, expiresAt.timeIntervalSince(deviceNow.addingTimeInterval(clockOffset)))
	}

	public func isExpired(deviceNow: Date) -> Bool {
		remaining(deviceNow: deviceNow) <= 0
	}

	/// "6:42" style countdown.
	public func countdownLabel(deviceNow: Date) -> String {
		let seconds = Int(remaining(deviceNow: deviceNow).rounded(.up))
		return String(format: "%d:%02d", seconds / 60, seconds % 60)
	}
}

// MARK: - Phases

public enum BookingPhase: Equatable, Sendable {
	case idle
	case searching
	case choosingTime
	/// A hold request is in flight.
	case holding
	/// A hold is active and the guest fills in the details (countdown running).
	case details
	case reviewing
	/// `POST /reservations` is in flight.
	case submitting
	case awaitingPayment
	case confirmed
	/// A large-party request was sent; the restaurant still has to approve it.
	case requested
	case expired
	case failed(BookingFailure)
}

// MARK: - Flow

public struct BookingFlow: Sendable {
	public private(set) var phase: BookingPhase = .idle
	public private(set) var locationId: String?
	public private(set) var date: String = ""
	public private(set) var partySize: Int = 2
	public private(set) var availability: ReservationAvailability?
	public private(set) var alternatives: ReservationAlternatives = .none
	public private(set) var selectedSlot: ReservationSlot?
	public private(set) var hold: ActiveHold?
	public private(set) var booking: ReservationBooking?
	public private(set) var paymentOutcome: ReservationPaymentOutcome?
	/// Set while a booking attempt may be retried after a network error.
	public private(set) var idempotencyKey: String?
	private var lastSubmitted: ReservationGuestDetails?
	/// A hold the guest abandoned; the view layer releases it, then clears this.
	public private(set) var holdToRelease: String?
	private let makeKey: @Sendable () -> String

	public init(makeKey: @escaping @Sendable () -> String = IdempotencyKey.make) {
		self.makeKey = makeKey
	}

	// MARK: Search

	public mutating func beginSearch(locationId: String, date: String, partySize: Int) {
		abandonHold()
		self.locationId = locationId
		self.date = date
		self.partySize = partySize
		availability = nil
		alternatives = .none
		selectedSlot = nil
		booking = nil
		paymentOutcome = nil
		clearAttempt()
		phase = .searching
	}

	public mutating func receive(availability: ReservationAvailability) {
		switch phase {
		case .searching, .choosingTime, .expired:
			phase = .choosingTime
		case .failed(.slotUnavailable):
			phase = .choosingTime
		case .details:
			// A live hold stays; only the list of times refreshes.
			break
		default:
			return
		}
		self.availability = availability
		alternatives = availability.alternatives
	}

	private var isFailedSlot: Bool {
		if case .failed(.slotUnavailable) = phase { return true }
		return false
	}

	/// A large party goes through a request instead of a hold.
	public var offersRequest: Bool {
		availability?.isLargeParty == true
	}

	/// A large party sends a request with a preferred time; there is no hold.
	public mutating func setRequestTime(localMin: Int) {
		guard offersRequest, phase == .choosingTime else { return }
		selectedSlot = ReservationSlot(localMin: localMin)
	}

	// MARK: Hold

	/// The guest picked a time (or one of the alternatives).
	public mutating func select(slot: ReservationSlot) {
		guard phase == .choosingTime || phase == .details || phase == .expired || isFailedSlot else { return }
		selectedSlot = slot
		phase = .holding
	}

	/// The guest picked an alternative day; searching restarts for that date.
	public mutating func selectAlternative(date: String) {
		guard let locationId else { return }
		beginSearch(locationId: locationId, date: date, partySize: partySize)
	}

	public mutating func receive(hold response: ReservationHold, deviceNow: Date) {
		guard phase == .holding else {
			// A late answer for a search the guest left: release it, never use it.
			holdToRelease = response.holdToken
			return
		}
		guard
			let expiresAt = ReservationClock.parse(response.expiresAt),
			let serverNow = ReservationClock.parse(response.now)
		else {
			holdToRelease = response.holdToken
			phase = .failed(.generic)
			return
		}
		hold = ActiveHold(
			token: response.holdToken,
			locationId: response.locationId,
			date: response.slot.date,
			localMin: response.slot.localMin,
			partySize: response.slot.partySize,
			serviceId: response.slot.serviceId,
			expiresAt: expiresAt,
			clockOffset: serverNow.timeIntervalSince(deviceNow),
			requiresPayment: response.requiresPayment ?? false,
			policy: response.policy
		)
		clearAttempt()
		phase = .details
	}

	public mutating func acknowledgeRelease() { holdToRelease = nil }

	/// The token a replacing hold request should send, if a hold is active.
	public var replaceableHoldToken: String? { hold?.token }

	public func remaining(deviceNow: Date) -> TimeInterval? {
		hold?.remaining(deviceNow: deviceNow)
	}

	/// Call on every countdown tick. Moves to `expired` when the server deadline
	/// passes while the guest is still filling in or reviewing. A request that is
	/// already in flight is left to the server to decide.
	@discardableResult
	public mutating func tick(deviceNow: Date) -> Bool {
		guard phase == .details || phase == .reviewing, let hold else { return false }
		guard hold.isExpired(deviceNow: deviceNow) else { return false }
		self.hold = nil
		clearAttempt()
		phase = .expired
		return true
	}

	/// The guest went back out of the booking; releases the held table.
	public mutating func abandonHold() {
		if let token = hold?.token { holdToRelease = token }
		hold = nil
	}

	// MARK: Details and review

	public var needsPolicyConsent: Bool { hold?.requiresPayment == true && hold?.policy != nil }

	/// The `termsVersion` to send once the guest consents; nil when no policy applies.
	public var policyTermsVersion: String? {
		guard needsPolicyConsent, let version = hold?.policy?.termsVersion else { return nil }
		return String(version)
	}

	/// First name and a phone are required; a payment policy also needs consent.
	public func canReview(_ details: ReservationGuestDetails, consented: Bool) -> Bool {
		guard !details.firstName.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
		guard PhoneNumber.isValid(PhoneNumber.normalize(details.phone)) else { return false }
		if needsPolicyConsent && !consented { return false }
		return true
	}

	public mutating func proceedToReview() {
		guard phase == .details else { return }
		phase = .reviewing
	}

	public mutating func backToDetails() {
		guard phase == .reviewing || isRecoverable else { return }
		if hold != nil { phase = .details }
	}

	private var isRecoverable: Bool {
		if case .failed(let failure) = phase { return failure.isRetryableWithSameKey || failure == .invalid }
		return false
	}

	// MARK: Submit

	/// Starts `POST /reservations` (or the large-party request when `isRequest`).
	/// Returns the `Idempotency-Key` to send: a new one for new details, the same
	/// one for a retry of the same details after a network error, so the server
	/// replays the first answer instead of booking twice.
	public mutating func beginSubmit(
		details: ReservationGuestDetails,
		isRequest: Bool = false
	) -> String? {
		let canSubmit: Bool
		switch phase {
		case .reviewing: canSubmit = true
		case .failed(let failure): canSubmit = failure.isRetryableWithSameKey && idempotencyKey != nil
		case .choosingTime: canSubmit = isRequest
		default: canSubmit = false
		}
		guard canSubmit else { return nil }
		if let key = idempotencyKey, lastSubmitted == details {
			phase = .submitting
			return key
		}
		let key = makeKey()
		idempotencyKey = key
		lastSubmitted = details
		phase = .submitting
		return key
	}

	public mutating func receive(booking response: ReservationBooking) {
		guard phase == .submitting else { return }
		booking = response
		hold = nil
		clearAttempt()
		paymentOutcome = nil
		let status = response.reservation.status
		if response.payment != nil || status == "pending_payment" {
			phase = .awaitingPayment
		} else if status == "requested" {
			phase = .requested
		} else {
			phase = .confirmed
		}
	}

	/// Maps a failed request to a phase. A hold that is gone ends the attempt; a
	/// taken slot offers the server's alternatives; an offline or paused answer
	/// keeps the idempotency key so the retry is safe.
	public mutating func receive(error: Error) {
		let failure = BookingFailure.map(error)
		switch failure {
		case .holdExpired:
			hold = nil
			clearAttempt()
			phase = .expired
		case .slotUnavailable(let offered):
			hold = nil
			clearAttempt()
			if !offered.isEmpty { alternatives = offered }
			phase = .failed(failure)
		default:
			if !failure.isRetryableWithSameKey { clearAttempt() }
			phase = .failed(failure)
		}
	}

	// MARK: Payment

	/// Applies a payment status answer. `pending` keeps polling; every other
	/// outcome ends the wait.
	@discardableResult
	public mutating func receive(paymentStatus status: ReservationPaymentStatus) -> ReservationPaymentOutcome {
		let outcome = ReservationPaymentOutcome.interpret(status)
		guard phase == .awaitingPayment else { return outcome }
		paymentOutcome = outcome
		switch outcome {
		case .paid: phase = .confirmed
		case .expired: phase = .expired
		case .failed: phase = .failed(.paymentFailed)
		case .refunded: phase = .failed(.paymentRefunded)
		case .review, .pending: break
		}
		return outcome
	}

	/// The payment window of the booking, on the server clock.
	public func paymentSecondsRemaining(deviceNow: Date, serverOffset: TimeInterval) -> TimeInterval? {
		guard
			let raw = booking?.payment?.expiresAt ?? booking?.reservation.paymentExpiresAt,
			let expiresAt = ReservationClock.parse(raw)
		else { return nil }
		return max(0, expiresAt.timeIntervalSince(deviceNow.addingTimeInterval(serverOffset)))
	}

	// MARK: Reset

	public mutating func reset() {
		abandonHold()
		phase = .idle
		availability = nil
		alternatives = .none
		selectedSlot = nil
		booking = nil
		paymentOutcome = nil
		clearAttempt()
	}

	private mutating func clearAttempt() {
		idempotencyKey = nil
		lastSubmitted = nil
	}
}

// MARK: - Payment poll

/// Back-off for the payment status poll, the same schedule as the Sites pay
/// page: 1.5, 2.5, 4, 6, then every 10 seconds, for at most three minutes.
public enum PaymentPoll {
	public static let delays: [TimeInterval] = [1.5, 2.5, 4, 6, 10]
	public static let maxDuration: TimeInterval = 180

	public static func delay(afterAttempt attempt: Int) -> TimeInterval {
		delays[min(max(attempt, 0), delays.count - 1)]
	}

	public static func hasTimedOut(since start: Date, now: Date) -> Bool {
		now.timeIntervalSince(start) >= maxDuration
	}

	/// 401, 403 and 404 mean the link is dead: polling stops for good.
	public static func stops(on error: Error) -> Bool {
		if let error = error as? ReservationAPIError { return [401, 403, 404].contains(error.statusCode) }
		if let error = error as? APIError { return error.isUnauthorized || error.isNotFound }
		return false
	}
}

// MARK: - Manage eligibility

/// What the reservation detail screen offers, from the manage payload: the
/// server decides `canModify` and `canCancel` (cutoff windows, status); running
/// late is offered for a live booking until shortly after its start.
public struct ReservationManageActions: Equatable, Sendable {
	public let canModify: Bool
	public let canCancel: Bool
	public let canRunLate: Bool
	public let isLive: Bool

	public init(view: ReservationManageView) {
		isLive = ["booked", "confirmed", "requested", "pending_payment"].contains(view.status)
		canModify = view.canModify
		canCancel = view.canCancel
		canRunLate = view.canRunLate
	}
}

// MARK: - Waitlist

public enum WaitlistPhase: Equatable, Sendable {
	case idle
	case joining
	case waiting
	case left
	case seated
	case failed(BookingFailure)
	/// The status link no longer resolves (404).
	case linkInvalid
}

/// Join and status for the waitlist. The `Idempotency-Key` is reused when the
/// same join is retried after a network error.
public struct WaitlistFlow: Sendable {
	public private(set) var phase: WaitlistPhase = .idle
	public private(set) var status: ReservationWaitlistStatus?
	public private(set) var statusToken: String?
	public private(set) var idempotencyKey: String?
	private var lastJoin: String?
	private let makeKey: @Sendable () -> String

	public init(makeKey: @escaping @Sendable () -> String = IdempotencyKey.make) {
		self.makeKey = makeKey
	}

	public mutating func beginJoin(locationId: String, name: String, partySize: Int) -> String {
		let signature = "\(locationId)|\(name)|\(partySize)"
		let key: String
		if let existing = idempotencyKey, lastJoin == signature {
			key = existing
		} else {
			key = makeKey()
			idempotencyKey = key
			lastJoin = signature
		}
		phase = .joining
		return key
	}

	public mutating func receive(join: ReservationWaitlistJoin) {
		statusToken = join.statusToken
		idempotencyKey = nil
		lastJoin = nil
		phase = .waiting
	}

	public mutating func receive(status: ReservationWaitlistStatus) {
		self.status = status
		switch status.status {
		case "left", "cancelled", "removed", "no_show", "expired": phase = .left
		case "seated": phase = .seated
		default: phase = .waiting
		}
	}

	public mutating func receive(error: Error) {
		let failure = BookingFailure.map(error)
		if failure == .notFound, statusToken != nil {
			phase = .linkInvalid
			return
		}
		if !failure.isRetryableWithSameKey {
			idempotencyKey = nil
			lastJoin = nil
		}
		phase = .failed(failure)
	}
}

// MARK: - Dates

public enum ReservationDates {
	/// `count` business dates (`yyyy-MM-dd`) starting today in the location's time
	/// zone, capped by the booking horizon.
	public static func strip(
		now: Date,
		timeZone identifier: String,
		count: Int,
		horizonDays: Int
	) -> [String] {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: identifier) ?? TimeZone(secondsFromGMT: 0)!
		let limit = max(1, min(count, horizonDays + 1))
		var result: [String] = []
		for offset in 0..<limit {
			guard let day = calendar.date(byAdding: .day, value: offset, to: now) else { continue }
			let parts = calendar.dateComponents([.year, .month, .day], from: day)
			guard let year = parts.year, let month = parts.month, let dayOfMonth = parts.day else { continue }
			result.append(String(format: "%04d-%02d-%02d", year, month, dayOfMonth))
		}
		return result
	}
}
