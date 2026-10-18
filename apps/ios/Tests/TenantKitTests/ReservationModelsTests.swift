import XCTest

@testable import TenantKit

final class ReservationModelsTests: XCTestCase {
	func testEveryFixtureFileIsListedAndPresent() throws {
		for name in ReservationFixtures.names {
			XCTAssertGreaterThan(try ReservationFixtures.data(name).count, 2, name)
		}
	}

	func testDecodesConfig() throws {
		let config = try ReservationFixtures.decode(ReservationsConfig.self, "config")
		XCTAssertEqual(config.organization.name, "Acme Bistro")
		let location = try XCTUnwrap(config.locations.first)
		XCTAssertEqual(location.id, "loc_pub_main")
		XCTAssertEqual(location.partySize, ReservationPartyRange(min: 1, max: 4))
		XCTAssertEqual(location.holdMinutes, 7)
		XCTAssertTrue(location.largeParty.acceptsRequests)
		XCTAssertTrue(location.waitlist.online)
		XCTAssertTrue(location.notifyMe)
		XCTAssertEqual(location.areas.map(\.name), ["Main Room"])
		XCTAssertEqual(config.occasions.map(\.name), ["Birthday"])
		XCTAssertEqual(config.dietary.map(\.name), ["Nut allergy"])
	}

	func testDecodesAvailabilityWithSlots() throws {
		let availability = try ReservationFixtures.decode(ReservationAvailability.self, "availability")
		XCTAssertEqual(availability.status, "available")
		XCTAssertTrue(availability.hasSlots)
		XCTAssertEqual(availability.slots.first?.time.count, 5)
		XCTAssertEqual(availability.timeZone, "UTC")
		XCTAssertTrue(availability.waitlist)
	}

	func testDecodesAlternativesWhenThePreferredTimeIsTaken() throws {
		let availability = try ReservationFixtures.decode(
			ReservationAvailability.self,
			"availability-preferred-taken"
		)
		XCTAssertFalse(availability.alternatives.isEmpty)
		XCTAssertFalse(availability.alternatives.sameDay.isEmpty)
		XCTAssertFalse(availability.alternatives.otherDates.isEmpty)
		XCTAssertFalse(availability.slots.contains { $0.localMin == 18 * 60 })
	}

	func testDecodesCalendar() throws {
		let calendar = try ReservationFixtures.decode(ReservationCalendar.self, "calendar")
		XCTAssertEqual(calendar.days.count, 4)
		XCTAssertTrue(calendar.days.allSatisfy(\.hasAvailability))
	}

	func testDecodesHoldAndHoldWithPolicy() throws {
		let hold = try ReservationFixtures.decode(ReservationHold.self, "hold")
		XCTAssertTrue(hold.holdToken.hasPrefix("hold_fixture_token_"))
		XCTAssertNil(hold.requiresPayment)
		XCTAssertNil(hold.policy)

		let paid = try ReservationFixtures.decode(ReservationHold.self, "hold-requires-payment")
		XCTAssertEqual(paid.requiresPayment, true)
		XCTAssertEqual(paid.policy?.purpose, "deposit")
		XCTAssertEqual(paid.policy?.totalAmountMinor, 10_000)
		XCTAssertEqual(paid.policy?.termsVersion, 2)
	}

	func testDecodesBookingRequestAndPendingPayment() throws {
		let booked = try ReservationFixtures.decode(ReservationBooking.self, "booking")
		XCTAssertEqual(booked.reservation.status, "booked")
		XCTAssertEqual(booked.reservation.channel, "native")
		XCTAssertEqual(booked.reservation.confirmationCode.count, 8)
		XCTAssertNil(booked.payment)

		let requested = try ReservationFixtures.decode(ReservationBooking.self, "request")
		XCTAssertEqual(requested.reservation.status, "requested")

		let pending = try ReservationFixtures.decode(ReservationBooking.self, "booking-pending-payment")
		XCTAssertEqual(pending.reservation.status, "pending_payment")
		XCTAssertEqual(pending.reservation.paymentStatus, "pending")
		XCTAssertEqual(pending.payment?.purpose, "deposit")
		XCTAssertEqual(pending.payment?.amountMinor, 10_000)
		XCTAssertTrue(try XCTUnwrap(pending.payment).payUrl.contains("/reserve/pay#"))
	}

	func testDecodesManageView() throws {
		let view = try ReservationFixtures.decode(ReservationManageView.self, "manage")
		XCTAssertEqual(view.status, "booked")
		XCTAssertTrue(view.canModify)
		XCTAssertTrue(view.canCancel)
		XCTAssertNotNil(view.cancelDeadline)
		XCTAssertNil(view.policy)
		XCTAssertEqual(view.paymentStatus, "none")
		XCTAssertEqual(view.reservation.location.id, "loc_pub_main")
		XCTAssertNotNil(view.contact.phone)
	}

	func testDecodesMine() throws {
		let mine = try ReservationFixtures.decode(ReservationMine.self, "mine")
		XCTAssertEqual(mine.upcoming.count, 1)
		XCTAssertTrue(mine.past.isEmpty)
		XCTAssertFalse(try XCTUnwrap(mine.upcoming.first).manageToken.isEmpty)
	}

	func testPaymentStatusHasExactlyThreeFields() throws {
		let status = try ReservationFixtures.decode(ReservationPaymentStatus.self, "payment-status-pending")
		XCTAssertEqual(status.paymentStatus, "pending")
		XCTAssertEqual(status.reservationStatus, "pending_payment")
		let object = try XCTUnwrap(
			JSONSerialization.jsonObject(with: ReservationFixtures.data("payment-status-pending")) as? [String: Any]
		)
		XCTAssertEqual(Set(object.keys), ["paymentStatus", "reservationStatus", "now"])

		let none = try ReservationFixtures.decode(ReservationPaymentStatus.self, "payment-status-none")
		XCTAssertEqual(none.paymentStatus, "none")
	}

	func testDecodesWaitlist() throws {
		let joined = try ReservationFixtures.decode(ReservationWaitlistJoin.self, "waitlist-join")
		XCTAssertEqual(joined.entry.status, "waiting")
		XCTAssertEqual(joined.entry.position, 1)
		XCTAssertFalse(joined.statusToken.isEmpty)

		let status = try ReservationFixtures.decode(ReservationWaitlistStatus.self, "waitlist-status")
		XCTAssertEqual(status.status, "waiting")
		XCTAssertTrue(status.canLeave)
		XCTAssertTrue(status.canOnMyWay)
		XCTAssertNil(status.notifiedAt)
	}

	func testDecodesEveryErrorFixture() throws {
		let slot = ReservationAPIError.from(
			statusCode: 409,
			data: try ReservationFixtures.data("error-slot-unavailable")
		)
		XCTAssertEqual(slot.code, "slot_unavailable")
		XCTAssertEqual(slot.alternatives?.sameDay.isEmpty, false)

		let expired = ReservationAPIError.from(statusCode: 410, data: try ReservationFixtures.data("error-hold-expired"))
		XCTAssertEqual(expired.code, "hold_expired")

		let policy = ReservationAPIError.from(statusCode: 400, data: try ReservationFixtures.data("error-policy-required"))
		XCTAssertEqual(policy.code, "policy_required")

		let limited = ReservationAPIError.from(statusCode: 429, data: try ReservationFixtures.data("error-rate-limited"))
		XCTAssertEqual(limited.code, "rate_limited")
		XCTAssertEqual(limited.reason, "phone_active_limit")

		let invalid = ReservationAPIError.from(statusCode: 400, data: try ReservationFixtures.data("error-invalid"))
		XCTAssertEqual(invalid.code, "invalid")
	}

	func testParsesServerTimestampsWithAndWithoutMilliseconds() throws {
		let withMs = try XCTUnwrap(ReservationClock.parse("2030-06-14T16:00:00.000Z"))
		let without = try XCTUnwrap(ReservationClock.parse("2030-06-14T16:00:00Z"))
		XCTAssertEqual(withMs, without)
		XCTAssertNil(ReservationClock.parse("not a date"))
	}

	func testTimeLabelWrapsLateNightSlots() {
		XCTAssertEqual(ReservationClock.timeLabel(localMin: 19 * 60 + 5), "19:05")
		XCTAssertEqual(ReservationClock.timeLabel(localMin: 24 * 60 + 30), "00:30")
	}

	func testPaymentOutcomeFollowsTheSitesRules() {
		func outcome(_ payment: String, _ reservation: String) -> ReservationPaymentOutcome {
			ReservationPaymentOutcome.interpret(
				ReservationPaymentStatus(paymentStatus: payment, reservationStatus: reservation, now: "")
			)
		}
		XCTAssertEqual(outcome("paid", "booked"), .paid)
		XCTAssertEqual(outcome("guaranteed", "booked"), .paid)
		XCTAssertEqual(outcome("pending", "pending_payment"), .pending)
		XCTAssertEqual(outcome("pending", "expired"), .expired)
		XCTAssertEqual(outcome("pending", "cancelled"), .expired)
		XCTAssertEqual(outcome("review", "pending_payment"), .review)
		XCTAssertEqual(outcome("disputed", "booked"), .review)
		XCTAssertEqual(outcome("refunded", "cancelled"), .refunded)
		XCTAssertEqual(outcome("fee_failed", "booked"), .failed)
		// An unknown future status keeps polling rather than claiming success.
		XCTAssertEqual(outcome("something_new", "pending_payment"), .pending)
		XCTAssertFalse(ReservationPaymentOutcome.pending.isFinal)
		XCTAssertTrue(ReservationPaymentOutcome.paid.isFinal)
	}
}

final class ReservationTokenStoreTests: XCTestCase {
	func testRemembersAndForgetsManageAndWaitlistTokens() {
		let store = InMemoryReservationTokenStore()
		store.rememberManage(reservationId: "rsv_1", token: "tok_a")
		store.rememberManage(reservationId: "rsv_2", token: "tok_b")
		store.rememberWaitlist(entryId: "wle_1", token: "tok_w")
		XCTAssertEqual(store.load().manage["rsv_1"], "tok_a")
		XCTAssertEqual(store.load().waitlist["wle_1"], "tok_w")

		store.forgetManage(reservationId: "rsv_1")
		XCTAssertNil(store.load().manage["rsv_1"])
		XCTAssertEqual(store.load().manage["rsv_2"], "tok_b")

		store.clear()
		XCTAssertTrue(store.load().isEmpty)
	}

	func testStoredTokensRoundTripThroughJSON() throws {
		let tokens = StoredReservationTokens(manage: ["rsv_1": "tok_a"], waitlist: ["wle_1": "tok_w"])
		let data = try JSONEncoder().encode(tokens)
		XCTAssertEqual(try JSONDecoder().decode(StoredReservationTokens.self, from: data), tokens)
	}
}
