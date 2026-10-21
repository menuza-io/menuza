package com.epicstartup.tenant.core.reservations

import org.json.JSONObject

/** Loads the canonical contract fixtures (recorded from the real routes, see `fixtures:reservations`). */
object ReservationFixtures {
	val names = listOf(
		"availability", "availability-preferred-taken", "booking", "booking-pending-payment", "calendar",
		"config", "error-hold-expired", "error-invalid", "error-policy-required", "error-rate-limited",
		"error-slot-unavailable", "hold", "hold-requires-payment", "manage", "mine", "payment-status-none",
		"payment-status-pending", "request", "waitlist-join", "waitlist-status",
	)

	fun text(name: String): String {
		val stream = ReservationFixtures::class.java.classLoader!!
			.getResourceAsStream("reservations/$name.json")
			?: error("Missing fixture $name.json")
		return stream.use { String(it.readBytes(), Charsets.UTF_8) }
	}

	fun json(name: String): JSONObject = JSONObject(text(name))
}
