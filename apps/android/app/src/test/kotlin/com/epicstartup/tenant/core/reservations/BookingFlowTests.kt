package com.epicstartup.tenant.core.reservations

import com.epicstartup.tenant.core.net.ApiException
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BookingFlowTests {
	private val selection = ResSelection("loc_pub_main", "2030-06-24", 2)
	private val guest = ResGuest("Jane", "Doe", "+14155550123", null)
	private val details = ResBookingDetails(guest = guest, locale = "en")
	private val hold get() = ResHold.fromJson(ReservationFixtures.json("hold"))!!
	private val availability get() = ResAvailability.fromJson(ReservationFixtures.json("availability"))

	private fun reviewing(): BookingFlow = BookingFlow().apply {
		startSearch(selection)
		availabilityLoaded(selection, availability)
		holdAcquired(selection, hold, deviceNowMs = 1_000)
		beginDetails()
		review(details)
	}

	@Test
	fun walksSearchToConfirmed() {
		val flow = BookingFlow()
		assertEquals(FlowState.Idle, flow.state)
		flow.startSearch(selection)
		assertIs<FlowState.Searching>(flow.state)
		flow.availabilityLoaded(selection, availability)
		assertIs<FlowState.ChoosingTime>(flow.state)
		flow.holdAcquired(selection, hold, 0)
		assertIs<FlowState.Holding>(flow.state)
		flow.beginDetails()
		assertIs<FlowState.Details>(flow.state)
		flow.review(details)
		assertIs<FlowState.Reviewing>(flow.state)
		assertNotNull(flow.beginSubmit { "key-1" })
		flow.bookingSucceeded(ResBooking.fromJson(ReservationFixtures.json("booking"))!!)
		assertIs<FlowState.Confirmed>(flow.state)
		assertNull(flow.pendingKey)
	}

	@Test
	fun countdownUsesTheServerTimelineNotTheDeviceClock() {
		val held = hold
		val flow = BookingFlow()
		// The device clock is 3 minutes behind the server when the hold arrives.
		val deviceNow = held.serverNowMs - 3 * 60_000
		flow.holdAcquired(selection, held, deviceNow)
		assertEquals(3 * 60_000, flow.clockOffsetMs)
		// Same device instant: the full 7 minutes remain.
		assertEquals(7 * 60_000L, flow.holdRemainingMs(deviceNow))
		// 6:59 later on the device is 6:59 later on the server too.
		assertEquals(1_000L, flow.holdRemainingMs(deviceNow + 7 * 60_000 - 1_000))
		assertFalse(flow.tick(deviceNow + 7 * 60_000 - 1_000))
		// Exactly at expiresAt on the server timeline the hold is over.
		assertTrue(flow.tick(deviceNow + 7 * 60_000))
		assertEquals(FlowError.HoldExpired, (flow.state as FlowState.Expired).reason)
	}

	@Test
	fun expiryDuringASubmissionWaitsForTheServerAnswer() {
		val flow = reviewing()
		flow.beginSubmit { "key-1" }
		assertFalse(flow.tick(Long.MAX_VALUE / 4))
		assertIs<FlowState.Reviewing>(flow.state)
	}

	@Test
	fun slotUnavailableOnHoldKeepsTheSearchWithAlternatives() {
		val flow = BookingFlow()
		flow.startSearch(selection)
		flow.availabilityLoaded(selection, availability.copy(alternatives = ResAlternatives.none))
		val body = ReservationFixtures.json("error-slot-unavailable")
		flow.holdFailed(
			ReservationsException(409, "slot_unavailable", null, ResAlternatives.fromJson(body.getJSONObject("alternatives"))),
		)
		val state = flow.state as FlowState.ChoosingTime
		assertIs<FlowError.SlotUnavailable>(state.notice)
		assertFalse(state.availability.alternatives.isEmpty)
	}

	@Test
	fun alternativeDateRestartsTheSearchForThatDay() {
		val flow = BookingFlow()
		flow.startSearch(selection)
		flow.availabilityLoaded(selection, availability)
		flow.chooseAlternativeDate("2030-06-26")
		assertEquals("2030-06-26", (flow.state as FlowState.Searching).selection.date)
		assertEquals(2, (flow.state as FlowState.Searching).selection.partySize)
	}

	@Test
	fun errorMappingCoversTheContractCodes() {
		fun map(status: Int, code: String, reason: String? = null) =
			FlowError.from(ReservationsException(status, code, reason))
		assertIs<FlowError.SlotUnavailable>(map(409, "slot_unavailable"))
		assertEquals(FlowError.HoldExpired, map(410, "hold_expired"))
		assertEquals(FlowError.PolicyRequired, map(400, "policy_required"))
		assertEquals(FlowError.RateLimited("phone_active_limit"), map(429, "rate_limited", "phone_active_limit"))
		assertEquals(FlowError.VerificationFailed, map(403, "verification_failed"))
		assertEquals(FlowError.NotFound, map(404, "not_found"))
		assertEquals(FlowError.Network, FlowError.from(ApiException(0, "Network error")))
		assertEquals(FlowError.RateLimited(null), FlowError.from(ApiException(429, "slow down")))
		assertEquals(FlowError.HoldExpired, FlowError.from(ApiException(410, "gone")))
	}

	@Test
	fun bookingErrorsEndTheHoldOrKeepTheReview() {
		val expired = reviewing().apply {
			beginSubmit { "k" }
			bookingFailed(ReservationsException(410, "hold_expired"))
		}
		assertIs<FlowState.Expired>(expired.state)

		val policy = reviewing().apply {
			beginSubmit { "k" }
			bookingFailed(ReservationsException(400, "policy_required"))
		}
		val state = policy.state as FlowState.Reviewing
		assertFalse(state.submitting)
		assertEquals(FlowError.PolicyRequired, state.notice)
		assertNull(policy.pendingKey)
	}

	@Test
	fun networkErrorKeepsTheKeyAndChangedDetailsDropIt() {
		val flow = reviewing()
		val key = flow.beginSubmit { "key-1" }
		flow.bookingFailed(ApiException(0, "Network error"))
		assertEquals(key, flow.pendingKey)
		assertEquals(key, flow.beginSubmit { "key-2" })
		flow.bookingFailed(ApiException(0, "Network error"))

		flow.backToDetails()
		flow.review(details.copy(requests = "Window seat"))
		assertNull(flow.pendingKey)
		assertEquals("key-3", flow.beginSubmit { "key-3" })
	}

	@Test
	fun depositBookingWaitsForPaymentAndPollingSettlesIt() {
		val flow = reviewing()
		flow.beginSubmit { "k" }
		flow.bookingSucceeded(ResBooking.fromJson(ReservationFixtures.json("booking-pending-payment"))!!)
		assertIs<FlowState.AwaitingPayment>(flow.state)

		flow.paymentPolled(ResPaymentStatus.fromJson(ReservationFixtures.json("payment-status-pending")))
		assertEquals(PayOutcome.PENDING, (flow.state as FlowState.AwaitingPayment).outcome)

		flow.paymentPolled(ResPaymentStatus("review", "pending_payment", null))
		assertEquals(PayOutcome.REVIEW, (flow.state as FlowState.AwaitingPayment).outcome)

		flow.paymentPolled(ResPaymentStatus("fee_failed", "pending_payment", null))
		assertEquals(PayOutcome.FAILED, (flow.state as FlowState.AwaitingPayment).outcome)

		flow.paymentPolled(ResPaymentStatus("paid", "booked", null))
		val confirmed = flow.state as FlowState.Confirmed
		assertEquals("paid", confirmed.booking.paymentStatus)
	}

	@Test
	fun paymentOutcomesFollowTheSitesRules() {
		fun outcome(payment: String, reservation: String) =
			PaymentPoll.interpret(ResPaymentStatus(payment, reservation, null))
		assertEquals(PayOutcome.PAID, outcome("guaranteed", "booked"))
		assertEquals(PayOutcome.PAID, outcome("fee_charged", "booked"))
		assertEquals(PayOutcome.REVIEW, outcome("disputed", "booked"))
		assertEquals(PayOutcome.REFUNDED, outcome("partially_refunded", "booked"))
		assertEquals(PayOutcome.EXPIRED, outcome("pending", "expired"))
		assertEquals(PayOutcome.EXPIRED, outcome("pending", "cancelled"))
		assertEquals(PayOutcome.PENDING, outcome("pending", "pending_payment"))
	}

	@Test
	fun expiredPaymentMovesToExpired() {
		val flow = reviewing()
		flow.beginSubmit { "k" }
		flow.bookingSucceeded(ResBooking.fromJson(ReservationFixtures.json("booking-pending-payment"))!!)
		flow.paymentPolled(ResPaymentStatus("pending", "expired", null))
		assertTrue((flow.state as FlowState.Expired).paymentExpired)
	}

	@Test
	fun pollBackoffMatchesSitesAndRepeatsTheLastDelay() {
		assertEquals(listOf(1_500L, 2_500L, 4_000L, 6_000L, 10_000L, 10_000L), (0..5).map { PaymentPoll.delayMs(it) })
		assertEquals(180_000L, PaymentPoll.MAX_MS)
	}

	@Test
	fun manageEligibilityComesFromThePayload() {
		val view = ResManageView.fromJson(ReservationFixtures.json("manage"))!!
		val beforeEnd = view.reservation.endAtMs - 60_000
		val eligible = ManageEligibility.of(view, beforeEnd)
		assertTrue(eligible.canModify && eligible.canCancel && eligible.canRunLate)
		assertFalse(ManageEligibility.of(view, view.reservation.endAtMs + 1).canRunLate)
		val closed = view.copy(canModify = false, canCancel = false, reservation = view.reservation.copy(status = "cancelled"))
		val none = ManageEligibility.of(closed, beforeEnd)
		assertFalse(none.canModify || none.canCancel || none.canRunLate)
	}

	@Test
	fun largePartyRequestNeedsNoReview() {
		val flow = BookingFlow()
		flow.requestSucceeded(ResBooking.fromJson(ReservationFixtures.json("request"))!!)
		assertEquals("requested", (flow.state as FlowState.Confirmed).booking.reservation.status)
	}

	@Test
	fun waitlistJoinReusesKeyOnNetworkErrorAndTracksStatus() {
		val waitlist = WaitlistFlow()
		val key = waitlist.beginJoin { "wl-key-1" }
		waitlist.joinFailed(ApiException(0, "Network error"))
		assertEquals(key, waitlist.beginJoin { "wl-key-2" })
		waitlist.joinFailed(ReservationsException(404, "not_found"))
		assertEquals("wl-key-3", waitlist.beginJoin { "wl-key-3" })

		waitlist.joined(ResWaitlistJoin.fromJson(ReservationFixtures.json("waitlist-join"))!!)
		assertTrue(waitlist.isActive)
		assertNotNull(waitlist.statusToken)
		waitlist.statusUpdated(ResWaitlistStatus("left", null, 2, null, canLeave = false, canOnMyWay = false))
		assertFalse(waitlist.isActive)
		waitlist.clear()
		assertNull(waitlist.statusToken)
	}

	@Test
	fun coreNeverImportsAndroid() {
		val core = File("src/main/kotlin/com/epicstartup/tenant/core")
		if (!core.exists()) return
		val offenders = core.walkTopDown()
			.filter { it.isFile && it.extension == "kt" }
			.filter { file -> file.readLines().any { it.trim().startsWith("import android.") } }
			.map { it.name }
			.toList()
		assertEquals(emptyList(), offenders)
	}

	@Test
	fun allSixLocalesCarryEveryReservationString() {
		val res = File("src/main/res")
		if (!res.exists()) return
		fun keys(dir: String) = Regex("""<string name="(res_[a-z_]+)"[^>]*>([^<]*)</string>""")
			.findAll(File(res, "$dir/strings.xml").readText())
			.associate { it.groupValues[1] to it.groupValues[2] }
		val base = keys("values")
		assertTrue(base.size >= 80)
		listOf("ar", "de", "es", "fr", "zh").forEach { locale ->
			val translated = keys("values-$locale")
			assertEquals(base.keys, translated.keys, locale)
			translated.forEach { (key, value) -> assertTrue(value.isNotBlank(), "$locale $key") }
			// Placeholders survive translation.
			base.forEach { (key, value) ->
				val placeholders = Regex("%\\d\\$[ds]").findAll(value).map { it.value }.sorted().toList()
				assertEquals(placeholders, Regex("%\\d\\$[ds]").findAll(translated[key]!!).map { it.value }.sorted().toList(), "$locale $key")
			}
		}
	}
}
