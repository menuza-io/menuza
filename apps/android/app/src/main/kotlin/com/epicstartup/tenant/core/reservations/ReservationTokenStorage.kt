package com.epicstartup.tenant.core.reservations

/**
 * Where the capability tokens of the customer's bookings live: the manage token
 * per reservation id and the waitlist status token per location.
 *
 * They are bearer credentials for guest data, so the shipping app keeps them in
 * Keystore-backed storage (`KeystoreReservationTokenStorage`), never in plain
 * preferences, and nothing here is ever logged or put in a URL.
 */
interface ReservationTokenStorage {
	fun load(): Map<String, String>

	/** Returns `false` when the tokens could not be persisted. */
	fun save(tokens: Map<String, String>): Boolean
}

class InMemoryReservationTokenStorage(initial: Map<String, String> = emptyMap()) :
	ReservationTokenStorage {
	@Volatile
	private var tokens: Map<String, String> = initial

	override fun load(): Map<String, String> = tokens

	override fun save(tokens: Map<String, String>): Boolean {
		this.tokens = tokens
		return true
	}
}

/** Key helpers so reservation and waitlist tokens never collide. */
object ReservationTokenKeys {
	fun manage(reservationId: String) = "r:$reservationId"

	fun waitlist(locationId: String) = "w:$locationId"
}
