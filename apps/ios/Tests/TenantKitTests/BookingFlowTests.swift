import XCTest

@testable import TenantKit

final class BookingFlowTests: XCTestCase {
	private let base = ReservationClock.parse("2030-06-14T16:00:00.000Z")!

	private func iso(_ date: Date) -> String {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return formatter.string(from: date)
	}

	/// A hold whose server clock reads `serverNow` and which expires `seconds`
	/// after that, regardless of what the device clock says.
	private func makeHold(
		token: String = "hold_token_0001",
		serverNow: Date? = nil,
		expiresIn seconds: TimeInterval = 420,
		requiresPayment: Bool = false
	) throws -> ReservationHold {
		let now = serverNow ?? base
		var object: [String: Any] = [
			"holdToken": token,
			"expiresAt": iso(now.addingTimeInterval(seconds)),
			"now": iso(now),
			"locationId": "loc_pub_main",
			"slot": ["date": "2030-06-24", "localMin": 1140, "partySize": 2, "serviceId": "svc_pub_dinner"],
		]
		if requiresPayment {
			object["requiresPayment"] = true
			object["policy"] = [
				"kind": "deposit", "purpose": "deposit", "termsVersion": 2, "terms": "Terms",
				"amountMinor": 2500, "totalAmountMinor": 5000, "perCover": true, "currency": "USD",
				"freeCancelUntilMin": 1440, "lateCancelFeeMinor": 0, "noShowFeeMinor": 0,
			]
		}
		return try JSONDecoder().decode(
			ReservationHold.self,
			from: JSONSerialization.data(withJSONObject: object)
		)
	}

	private let details = ReservationGuestDetails(
		firstName: "Ada", lastName: "Lovelace", phone: "+14155553001", email: ""
	)

	private func searchedFlow(_ key: String = "key-0001") throws -> BookingFlow {
		var flow = BookingFlow(makeKey: { key })
		flow.beginSearch(locationId: "loc_pub_main", date: "2030-06-24", partySize: 2)
		flow.receive(availability: try ReservationFixtures.decode(ReservationAvailability.self, "availability"))
		return flow
	}

	private func holdingFlow(requiresPayment: Bool = false, key: String = "key-0001") throws -> BookingFlow {
		var flow = try searchedFlow(key)
		flow.select(slot: try XCTUnwrap(flow.availability?.slots.first))
		flow.receive(hold: try makeHold(requiresPayment: requiresPayment), deviceNow: base)
		return flow
	}

	// MARK: Transitions

	func testHappyPathSearchSlotHoldDetailsReviewSubmitConfirmed() throws {
		var flow = BookingFlow(makeKey: { "key-0001" })
		XCTAssertEqual(flow.phase, .idle)

		flow.beginSearch(locationId: "loc_pub_main", date: "2030-06-24", partySize: 2)
		XCTAssertEqual(flow.phase, .searching)

		flow.receive(availability: try ReservationFixtures.decode(ReservationAvailability.self, "availability"))
		XCTAssertEqual(flow.phase, .choosingTime)
		XCTAssertFalse(flow.offersRequest)

		let slot = try XCTUnwrap(flow.availability?.slots.first)
		flow.select(slot: slot)
		XCTAssertEqual(flow.phase, .holding)
		XCTAssertEqual(flow.selectedSlot, slot)

		flow.receive(hold: try makeHold(), deviceNow: base)
		XCTAssertEqual(flow.phase, .details)
		XCTAssertNotNil(flow.hold)

		XCTAssertTrue(flow.canReview(details, consented: false))
		flow.proceedToReview()
		XCTAssertEqual(flow.phase, .reviewing)

		let key = flow.beginSubmit(details: details)
		XCTAssertEqual(key, "key-0001")
		XCTAssertEqual(flow.phase, .submitting)

		flow.receive(booking: try ReservationFixtures.decode(ReservationBooking.self, "booking"))
		XCTAssertEqual(flow.phase, .confirmed)
		XCTAssertNil(flow.hold)
		XCTAssertNil(flow.idempotencyKey)
		XCTAssertEqual(flow.booking?.reservation.status, "booked")
	}

	func testDepositBookingWaitsForPaymentThenConfirmsOnPaid() throws {
		var flow = try holdingFlow(requiresPayment: true)
		XCTAssertTrue(flow.needsPolicyConsent)
		XCTAssertEqual(flow.policyTermsVersion, "2")
		XCTAssertFalse(flow.canReview(details, consented: false), "a policy needs consent")
		XCTAssertTrue(flow.canReview(details, consented: true))

		flow.proceedToReview()
		_ = flow.beginSubmit(details: details)
		flow.receive(booking: try ReservationFixtures.decode(ReservationBooking.self, "booking-pending-payment"))
		XCTAssertEqual(flow.phase, .awaitingPayment)

		let pending = flow.receive(
			paymentStatus: try ReservationFixtures.decode(ReservationPaymentStatus.self, "payment-status-pending")
		)
		XCTAssertEqual(pending, .pending)
		XCTAssertEqual(flow.phase, .awaitingPayment)

		let paid = flow.receive(
			paymentStatus: ReservationPaymentStatus(paymentStatus: "paid", reservationStatus: "booked", now: "")
		)
		XCTAssertEqual(paid, .paid)
		XCTAssertEqual(flow.phase, .confirmed)
	}

	func testPaymentPollStopsOnFinalOutcomesAndExpiredEndsTheAttempt() throws {
		func awaiting() throws -> BookingFlow {
			var flow = try holdingFlow(requiresPayment: true)
			flow.proceedToReview()
			_ = flow.beginSubmit(details: details)
			flow.receive(booking: try ReservationFixtures.decode(ReservationBooking.self, "booking-pending-payment"))
			return flow
		}
		var expired = try awaiting()
		expired.receive(paymentStatus: ReservationPaymentStatus(
			paymentStatus: "pending", reservationStatus: "expired", now: ""
		))
		XCTAssertEqual(expired.phase, .expired)

		var review = try awaiting()
		let outcome = review.receive(paymentStatus: ReservationPaymentStatus(
			paymentStatus: "review", reservationStatus: "pending_payment", now: ""
		))
		XCTAssertEqual(outcome, .review)
		XCTAssertTrue(outcome.isFinal)
		XCTAssertEqual(review.phase, .awaitingPayment, "review keeps the booking page and says it is being checked")

		var refunded = try awaiting()
		refunded.receive(paymentStatus: ReservationPaymentStatus(
			paymentStatus: "refunded", reservationStatus: "cancelled", now: ""
		))
		XCTAssertEqual(refunded.phase, .failed(.paymentRefunded))
	}

	func testLargePartyRequestEndsAsRequested() throws {
		var flow = BookingFlow(makeKey: { "key-0007" })
		flow.beginSearch(locationId: "loc_pub_main", date: "2030-06-24", partySize: 8)
		// The location is in request mode for this party size.
		let data = try ReservationFixtures.data("availability")
		var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		object["status"] = "large_party"
		object["slots"] = [Any]()
		flow.receive(availability: try JSONDecoder().decode(
			ReservationAvailability.self,
			from: JSONSerialization.data(withJSONObject: object)
		))
		XCTAssertTrue(flow.offersRequest)
		flow.setRequestTime(localMin: 19 * 60)
		XCTAssertEqual(flow.selectedSlot?.localMin, 1140)
		XCTAssertEqual(flow.phase, .choosingTime, "a request never holds a table")
		XCTAssertEqual(flow.beginSubmit(details: details, isRequest: true), "key-0007")
		flow.receive(booking: try ReservationFixtures.decode(ReservationBooking.self, "request"))
		XCTAssertEqual(flow.phase, .requested)
	}

	// MARK: Countdown

	func testCountdownUsesTheServerClockNotTheDeviceClock() throws {
		// The device clock runs 3 minutes behind the server.
		let deviceNow = base.addingTimeInterval(-180)
		var flow = try searchedFlow()
		flow.select(slot: try XCTUnwrap(flow.availability?.slots.first))
		flow.receive(hold: try makeHold(serverNow: base, expiresIn: 420), deviceNow: deviceNow)

		let hold = try XCTUnwrap(flow.hold)
		XCTAssertEqual(hold.clockOffset, 180, accuracy: 0.001)
		XCTAssertEqual(hold.remaining(deviceNow: deviceNow), 420, accuracy: 0.001)
		XCTAssertEqual(hold.countdownLabel(deviceNow: deviceNow), "7:00")

		// 419 seconds later on the device the hold has 1 second left.
		XCTAssertEqual(hold.remaining(deviceNow: deviceNow.addingTimeInterval(419)), 1, accuracy: 0.001)
		XCTAssertFalse(flow.tick(deviceNow: deviceNow.addingTimeInterval(419)))
		XCTAssertEqual(flow.phase, .details)

		// A naive "device now + 7 minutes" deadline would still be open here.
		XCTAssertTrue(flow.tick(deviceNow: deviceNow.addingTimeInterval(420)))
		XCTAssertEqual(flow.phase, .expired)
		XCTAssertNil(flow.hold)
	}

	func testAHoldExpiresWhileReviewingButNotWhileSubmitting() throws {
		var reviewing = try holdingFlow()
		reviewing.proceedToReview()
		XCTAssertTrue(reviewing.tick(deviceNow: base.addingTimeInterval(500)))
		XCTAssertEqual(reviewing.phase, .expired)

		var submitting = try holdingFlow()
		submitting.proceedToReview()
		_ = submitting.beginSubmit(details: details)
		XCTAssertFalse(submitting.tick(deviceNow: base.addingTimeInterval(500)), "the server decides an in-flight booking")
		XCTAssertEqual(submitting.phase, .submitting)
	}

	func testCountdownLabelFormatsMinutesAndSeconds() throws {
		let hold = try XCTUnwrap(try holdingFlow().hold)
		XCTAssertEqual(hold.countdownLabel(deviceNow: base.addingTimeInterval(375)), "0:45")
		XCTAssertEqual(hold.countdownLabel(deviceNow: base.addingTimeInterval(1000)), "0:00")
	}

	// MARK: Alternatives and errors

	func testSlotUnavailableSurfacesAlternativesFromTheServerAnswer() throws {
		var flow = try holdingFlow()
		flow.proceedToReview()
		_ = flow.beginSubmit(details: details)
		let error = ReservationAPIError.from(
			statusCode: 409,
			data: try ReservationFixtures.data("error-slot-unavailable")
		)
		flow.receive(error: error)

		guard case .failed(.slotUnavailable(let offered)) = flow.phase else {
			return XCTFail("expected slotUnavailable, got \(flow.phase)")
		}
		XCTAssertFalse(offered.sameDay.isEmpty)
		XCTAssertEqual(flow.alternatives, offered)
		XCTAssertNil(flow.hold)
		XCTAssertNil(flow.idempotencyKey, "a refused booking never reuses its key")

		// Choosing an alternative goes back through a fresh hold.
		flow.select(slot: try XCTUnwrap(offered.sameDay.first))
		XCTAssertEqual(flow.phase, .holding)
	}

	func testAnExpiredHoldCanBeReplacedByPickingATimeAgain() throws {
		var flow = try holdingFlow()
		XCTAssertTrue(flow.tick(deviceNow: base.addingTimeInterval(900)))
		XCTAssertEqual(flow.phase, .expired)
		flow.receive(availability: try ReservationFixtures.decode(ReservationAvailability.self, "availability"))
		XCTAssertEqual(flow.phase, .choosingTime)
		flow.select(slot: try XCTUnwrap(flow.availability?.slots.first))
		XCTAssertEqual(flow.phase, .holding)
		flow.receive(hold: try makeHold(token: "hold_token_0002"), deviceNow: base.addingTimeInterval(900))
		XCTAssertEqual(flow.phase, .details)
		XCTAssertEqual(flow.hold?.token, "hold_token_0002")
	}

	func testRefreshingTimesWhileDetailsAreOpenKeepsTheHold() throws {
		var flow = try holdingFlow()
		flow.receive(availability: try ReservationFixtures.decode(ReservationAvailability.self, "availability"))
		XCTAssertEqual(flow.phase, .details)
		XCTAssertNotNil(flow.hold)
	}

	func testAvailabilityAlternativesAreKeptWhenThePreferredTimeIsTaken() throws {
		var flow = BookingFlow()
		flow.beginSearch(locationId: "loc_pub_main", date: "2030-06-25", partySize: 4)
		flow.receive(availability: try ReservationFixtures.decode(
			ReservationAvailability.self, "availability-preferred-taken"
		))
		XCTAssertFalse(flow.alternatives.sameDay.isEmpty)
		XCTAssertFalse(flow.alternatives.otherDates.isEmpty)
		flow.selectAlternative(date: try XCTUnwrap(flow.alternatives.otherDates.first).date)
		XCTAssertEqual(flow.phase, .searching)
		XCTAssertTrue(flow.alternatives.isEmpty)
	}

	func testErrorMappingForTheFourDocumentedCodes() {
		func map(_ status: Int, _ code: String, reason: String? = nil) -> BookingFailure {
			BookingFailure.map(ReservationAPIError(statusCode: status, code: code, reason: reason))
		}
		XCTAssertEqual(map(409, "slot_unavailable"), .slotUnavailable(.none))
		XCTAssertEqual(map(410, "hold_expired"), .holdExpired)
		XCTAssertEqual(map(400, "policy_required"), .policyRequired)
		XCTAssertEqual(map(429, "rate_limited"), .rateLimited(reason: nil))
		XCTAssertEqual(map(429, "rate_limited", reason: "phone_active_limit"), .rateLimited(reason: "phone_active_limit"))
		XCTAssertEqual(map(403, "verification_failed"), .signInRequired)
		XCTAssertEqual(map(503, "unavailable"), .paused)
		XCTAssertEqual(map(404, "not_found"), .notFound)
		XCTAssertEqual(map(409, "phone_overlap"), .phoneOverlap)
		XCTAssertEqual(map(410, "something_else"), .holdExpired)
		XCTAssertEqual(BookingFailure.map(APIError(statusCode: 0, message: "x")), .offline)
		XCTAssertEqual(BookingFailure.map(APIError.unauthorized), .signInRequired)
	}

	func testHoldExpiredFromTheServerEndsTheAttempt() throws {
		var flow = try holdingFlow()
		flow.proceedToReview()
		_ = flow.beginSubmit(details: details)
		flow.receive(error: ReservationAPIError(statusCode: 410, code: "hold_expired"))
		XCTAssertEqual(flow.phase, .expired)
		XCTAssertNil(flow.hold)
	}

	// MARK: Idempotency

	func testARetryAfterANetworkErrorReusesTheIdempotencyKey() throws {
		let counter = Counter()
		var flow = BookingFlow(makeKey: { "key-\(counter.increment())" })
		flow.beginSearch(locationId: "loc_pub_main", date: "2030-06-24", partySize: 2)
		flow.receive(availability: try ReservationFixtures.decode(ReservationAvailability.self, "availability"))
		flow.select(slot: try XCTUnwrap(flow.availability?.slots.first))
		flow.receive(hold: try makeHold(), deviceNow: base)
		flow.proceedToReview()

		XCTAssertEqual(flow.beginSubmit(details: details), "key-1")
		flow.receive(error: APIError(statusCode: 0, message: "offline"))
		XCTAssertEqual(flow.phase, .failed(.offline))
		XCTAssertEqual(flow.idempotencyKey, "key-1")

		// Same details, same key: the server replays instead of booking twice.
		XCTAssertEqual(flow.beginSubmit(details: details), "key-1")
		XCTAssertEqual(flow.phase, .submitting)
		flow.receive(error: APIError(statusCode: 0, message: "offline"))

		// Changed details are a different request and need a different key.
		var edited = details
		edited.requests = "Quiet table"
		flow.backToDetails()
		XCTAssertEqual(flow.phase, .details)
		flow.proceedToReview()
		XCTAssertEqual(flow.beginSubmit(details: edited), "key-2")
		XCTAssertEqual(counter.count, 2)
	}

	func testARefusedBookingDoesNotKeepItsKey() throws {
		var flow = try holdingFlow()
		flow.proceedToReview()
		_ = flow.beginSubmit(details: details)
		flow.receive(error: ReservationAPIError(statusCode: 400, code: "invalid"))
		XCTAssertNil(flow.idempotencyKey)
		XCTAssertEqual(flow.phase, .failed(.invalid))
	}

	func testRateLimitedByPhoneActiveLimitIsNotRetryable() {
		XCTAssertFalse(BookingFailure.rateLimited(reason: "phone_active_limit").isRetryableWithSameKey)
		XCTAssertTrue(BookingFailure.rateLimited(reason: nil).isRetryableWithSameKey)
		XCTAssertTrue(BookingFailure.offline.isRetryableWithSameKey)
		XCTAssertFalse(BookingFailure.holdExpired.isRetryableWithSameKey)
	}

	// MARK: Holds

	func testAbandoningAHoldAsksTheViewLayerToReleaseIt() throws {
		var flow = try holdingFlow()
		flow.beginSearch(locationId: "loc_pub_main", date: "2030-06-25", partySize: 2)
		XCTAssertEqual(flow.holdToRelease, "hold_token_0001")
		XCTAssertNil(flow.hold)
		flow.acknowledgeRelease()
		XCTAssertNil(flow.holdToRelease)
	}

	func testALateHoldAnswerAfterTheGuestMovedOnIsReleasedNotUsed() throws {
		var flow = try searchedFlow()
		flow.select(slot: try XCTUnwrap(flow.availability?.slots.first))
		flow.reset()
		flow.receive(hold: try makeHold(token: "hold_token_late"), deviceNow: base)
		XCTAssertEqual(flow.phase, .idle)
		XCTAssertNil(flow.hold)
		XCTAssertEqual(flow.holdToRelease, "hold_token_late")
	}

	func testReviewNeedsAFirstNameAndAValidPhone() throws {
		let flow = try holdingFlow()
		XCTAssertFalse(flow.canReview(ReservationGuestDetails(firstName: " ", phone: "+14155553001"), consented: false))
		XCTAssertFalse(flow.canReview(ReservationGuestDetails(firstName: "Ada", phone: "12"), consented: false))
		XCTAssertTrue(flow.canReview(ReservationGuestDetails(firstName: "Ada", phone: "+1 (415) 555-3001"), consented: false))
	}

	// MARK: Poll schedule

	func testPaymentPollBacksOffAndTimesOut() {
		XCTAssertEqual(PaymentPoll.delay(afterAttempt: 0), 1.5)
		XCTAssertEqual(PaymentPoll.delay(afterAttempt: 1), 2.5)
		XCTAssertEqual(PaymentPoll.delay(afterAttempt: 4), 10)
		XCTAssertEqual(PaymentPoll.delay(afterAttempt: 40), 10)
		let start = base
		XCTAssertFalse(PaymentPoll.hasTimedOut(since: start, now: start.addingTimeInterval(179)))
		XCTAssertTrue(PaymentPoll.hasTimedOut(since: start, now: start.addingTimeInterval(180)))
		XCTAssertTrue(PaymentPoll.stops(on: ReservationAPIError(statusCode: 404, code: "not_found")))
		XCTAssertTrue(PaymentPoll.stops(on: ReservationAPIError(statusCode: 403, code: "forbidden")))
		XCTAssertFalse(PaymentPoll.stops(on: APIError(statusCode: 0, message: "offline")))
	}

	// MARK: Manage eligibility

	func testManageActionsFollowTheServerPayload() throws {
		let view = try ReservationFixtures.decode(ReservationManageView.self, "manage")
		let actions = ReservationManageActions(view: view)
		XCTAssertTrue(actions.canModify)
		XCTAssertTrue(actions.canCancel)
		XCTAssertTrue(actions.canRunLate, "a booked reservation can run late until shortly after its start")
		XCTAssertTrue(actions.isLive)
	}

	func testManageActionsWhenTheWindowHasClosed() throws {
		var object = try XCTUnwrap(
			JSONSerialization.jsonObject(with: ReservationFixtures.data("manage")) as? [String: Any]
		)
		object["canModify"] = false
		object["canCancel"] = false
		object["status"] = "cancelled"
		let view = try JSONDecoder().decode(
			ReservationManageView.self,
			from: JSONSerialization.data(withJSONObject: object)
		)
		let actions = ReservationManageActions(view: view)
		XCTAssertFalse(actions.canModify)
		XCTAssertFalse(actions.canCancel)
		XCTAssertFalse(actions.canRunLate)
		XCTAssertFalse(actions.isLive)
	}

	// MARK: Waitlist

	func testWaitlistJoinReusesItsKeyAfterANetworkErrorAndStoresTheStatusToken() throws {
		let counter = Counter()
		var flow = WaitlistFlow(makeKey: { "wl-\(counter.increment())" })
		XCTAssertEqual(flow.beginJoin(locationId: "loc_pub_main", name: "Ada", partySize: 2), "wl-1")
		flow.receive(error: APIError(statusCode: 0, message: "offline"))
		XCTAssertEqual(flow.phase, .failed(.offline))
		XCTAssertEqual(flow.beginJoin(locationId: "loc_pub_main", name: "Ada", partySize: 2), "wl-1")
		XCTAssertEqual(flow.beginJoin(locationId: "loc_pub_main", name: "Ada", partySize: 3), "wl-2")

		flow.receive(join: try ReservationFixtures.decode(ReservationWaitlistJoin.self, "waitlist-join"))
		XCTAssertEqual(flow.phase, .waiting)
		XCTAssertNotNil(flow.statusToken)
		XCTAssertNil(flow.idempotencyKey)

		flow.receive(status: try ReservationFixtures.decode(ReservationWaitlistStatus.self, "waitlist-status"))
		XCTAssertEqual(flow.phase, .waiting)
		XCTAssertEqual(flow.status?.position, 1)
	}

	func testWaitlistStatusLeftSeatedAndDeadLink() throws {
		var flow = WaitlistFlow(makeKey: { "wl-1" })
		flow.receive(join: try ReservationFixtures.decode(ReservationWaitlistJoin.self, "waitlist-join"))
		var object = try XCTUnwrap(
			JSONSerialization.jsonObject(with: ReservationFixtures.data("waitlist-status")) as? [String: Any]
		)
		object["status"] = "left"
		flow.receive(status: try JSONDecoder().decode(
			ReservationWaitlistStatus.self, from: JSONSerialization.data(withJSONObject: object)
		))
		XCTAssertEqual(flow.phase, .left)

		object["status"] = "seated"
		flow.receive(status: try JSONDecoder().decode(
			ReservationWaitlistStatus.self, from: JSONSerialization.data(withJSONObject: object)
		))
		XCTAssertEqual(flow.phase, .seated)

		flow.receive(error: ReservationAPIError(statusCode: 404, code: "not_found"))
		XCTAssertEqual(flow.phase, .linkInvalid)
	}

	// MARK: Dates

	func testDateStripStartsTodayInTheLocationTimeZoneAndRespectsTheHorizon() {
		// 23:30 UTC on June 14 is already June 15 in Riyadh (UTC+3).
		let lateUTC = ReservationClock.parse("2030-06-14T23:30:00.000Z")!
		let riyadh = ReservationDates.strip(now: lateUTC, timeZone: "Asia/Riyadh", count: 3, horizonDays: 60)
		XCTAssertEqual(riyadh, ["2030-06-15", "2030-06-16", "2030-06-17"])
		let utc = ReservationDates.strip(now: lateUTC, timeZone: "UTC", count: 3, horizonDays: 60)
		XCTAssertEqual(utc.first, "2030-06-14")
		XCTAssertEqual(ReservationDates.strip(now: lateUTC, timeZone: "UTC", count: 14, horizonDays: 2).count, 3)
	}

	func testIdempotencyKeysMatchTheServerPattern() {
		let key = IdempotencyKey.make()
		XCTAssertNotNil(key.range(of: "^[A-Za-z0-9._:-]{8,128}$", options: .regularExpression))
		XCTAssertNotEqual(key, IdempotencyKey.make())
	}
}
