package com.epicstartup.tenant.core.reservations

import java.io.File
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReservationFixtureTests {
	@Test
	fun everyCanonicalFixtureIsPresent() {
		assertEquals(20, ReservationFixtures.names.size)
		ReservationFixtures.names.forEach { assertTrue(ReservationFixtures.text(it).isNotBlank(), it) }
	}

	@Test
	fun decodesConfig() {
		val config = ResConfig.fromJson(ReservationFixtures.json("config"))
		assertEquals("Acme Bistro", config.organizationName)
		val location = config.locations.single()
		assertEquals("loc_pub_main", location.id)
		assertEquals(4, location.partyMax)
		assertEquals(7, location.holdMinutes)
		assertEquals("request", location.largePartyMode)
		assertTrue(location.waitlistOnline)
		assertEquals(1, location.areas.size)
		assertEquals(1, config.occasions.size)
		assertEquals(1, config.dietary.size)
		assertNotNull(config.nowMs)
	}

	@Test
	fun decodesAvailabilityAndAlternatives() {
		val availability = ResAvailability.fromJson(ReservationFixtures.json("availability"))
		assertEquals("available", availability.status)
		assertTrue(availability.slots.isNotEmpty())
		assertEquals("19:00", availability.slots.first { it.localMin == 1140 }.time)

		val taken = ResAvailability.fromJson(ReservationFixtures.json("availability-preferred-taken"))
		assertFalse(taken.alternatives.isEmpty)
		assertTrue(taken.alternatives.sameDay.isNotEmpty())
		assertTrue(taken.alternatives.otherDates.isNotEmpty())
	}

	@Test
	fun decodesCalendar() {
		val calendar = ResCalendar.fromJson(ReservationFixtures.json("calendar"))
		assertEquals(4, calendar.days.size)
		assertTrue(calendar.days.all { it.hasAvailability })
	}

	@Test
	fun decodesHoldsWithAndWithoutPolicy() {
		val hold = ResHold.fromJson(ReservationFixtures.json("hold"))!!
		assertFalse(hold.requiresPayment)
		assertNull(hold.policy)
		assertEquals(7 * 60_000L, hold.expiresAtMs - hold.serverNowMs)

		val paid = ResHold.fromJson(ReservationFixtures.json("hold-requires-payment"))!!
		assertTrue(paid.requiresPayment)
		assertEquals(2, paid.policy!!.termsVersion)
		assertEquals(10_000, paid.policy!!.totalAmountMinor)
	}

	@Test
	fun decodesBookings() {
		val booking = ResBooking.fromJson(ReservationFixtures.json("booking"))!!
		assertEquals("booked", booking.reservation.status)
		assertEquals("none", booking.paymentStatus)
		assertNull(booking.payment)

		val pending = ResBooking.fromJson(ReservationFixtures.json("booking-pending-payment"))!!
		assertEquals("pending_payment", pending.reservation.status)
		assertEquals("deposit", pending.payment!!.purpose)
		assertTrue(pending.payment!!.payUrl.startsWith("https://"))

		val request = ResBooking.fromJson(ReservationFixtures.json("request"))!!
		assertEquals("requested", request.reservation.status)
	}

	@Test
	fun decodesManageViewAndPaymentStatus() {
		val view = ResManageView.fromJson(ReservationFixtures.json("manage"))!!
		assertTrue(view.canModify)
		assertTrue(view.canCancel)
		assertNotNull(view.cancelDeadlineMs)
		assertEquals("booked", view.reservation.status)

		val none = ResPaymentStatus.fromJson(ReservationFixtures.json("payment-status-none"))
		assertEquals("none", none.paymentStatus)
		val pending = ResPaymentStatus.fromJson(ReservationFixtures.json("payment-status-pending"))
		assertEquals("pending_payment", pending.reservationStatus)
		assertEquals(PayOutcome.PENDING, PaymentPoll.interpret(pending))
	}

	@Test
	fun decodesMineWithManageTokens() {
		val mine = ResMine.fromJson(ReservationFixtures.json("mine"))
		assertEquals(1, mine.upcoming.size)
		assertTrue(mine.upcoming.single().manageToken.isNotEmpty())
		assertTrue(mine.past.isEmpty())
	}

	@Test
	fun decodesWaitlist() {
		val join = ResWaitlistJoin.fromJson(ReservationFixtures.json("waitlist-join"))!!
		assertEquals("waiting", join.status)
		assertEquals(1, join.position)
		val status = ResWaitlistStatus.fromJson(ReservationFixtures.json("waitlist-status"))
		assertTrue(status.isActive)
		assertTrue(status.canLeave)
	}

	@Test
	fun mapsEveryErrorFixtureToAFlowError() {
		fun mapped(name: String, status: Int): FlowError {
			val json = ReservationFixtures.json(name)
			val error = ReservationsException(
				statusCode = status,
				code = json.getString("error"),
				reason = json.optString("reason").ifEmpty { null },
				alternatives = ResAlternatives.fromJson(json.optJSONObject("alternatives")),
			)
			return FlowError.from(error)
		}
		val slot = mapped("error-slot-unavailable", 409) as FlowError.SlotUnavailable
		assertFalse(slot.alternatives.isEmpty)
		assertEquals(FlowError.HoldExpired, mapped("error-hold-expired", 410))
		assertEquals(FlowError.PolicyRequired, mapped("error-policy-required", 400))
		assertEquals(FlowError.RateLimited("phone_active_limit"), mapped("error-rate-limited", 429))
		assertEquals(FlowError.Invalid, mapped("error-invalid", 400))
	}

	@Test
	fun androidAndCanonicalFixturesAreByteIdentical() {
		// Gradle runs unit tests with the module directory (`app`) as the working directory.
		val canonical = File("../../../packages/reservations/contract-fixtures")
		if (!canonical.exists()) return // building outside the monorepo
		val android = File("src/test/resources/reservations")
		val names = canonical.listFiles { f -> f.name.endsWith(".json") }!!.map { it.name }.sorted()
		assertEquals(names, android.listFiles { f -> f.name.endsWith(".json") }!!.map { it.name }.sorted())
		fun digest(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).toList()
		names.forEach { assertEquals(digest(File(canonical, it)), digest(File(android, it)), it) }
	}
}
