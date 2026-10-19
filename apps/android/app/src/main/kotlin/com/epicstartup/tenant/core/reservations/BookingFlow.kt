package com.epicstartup.tenant.core.reservations

import com.epicstartup.tenant.core.net.ApiException

/** What the guest searched for. */
data class ResSelection(val locationId: String, val date: String, val partySize: Int)

/** The failures a guest can hit; the UI maps each to a localized message. */
sealed interface FlowError {
	data class SlotUnavailable(val alternatives: ResAlternatives) : FlowError
	data object HoldExpired : FlowError
	data object PolicyRequired : FlowError
	data class RateLimited(val reason: String?) : FlowError
	data object VerificationFailed : FlowError
	data object PhoneOverlap : FlowError
	data object NotFound : FlowError
	data object Invalid : FlowError
	data object Network : FlowError
	data class Other(val code: String) : FlowError

	companion object {
		fun from(error: Exception): FlowError {
			val api = error as? ApiException ?: return Network
			if (api.isTransportFailure) return Network
			val reservations = error as? ReservationsException
			return when (reservations?.code ?: api.message) {
				"slot_unavailable" -> SlotUnavailable(reservations?.alternatives ?: ResAlternatives.none)
				"hold_expired" -> HoldExpired
				"policy_required" -> PolicyRequired
				"rate_limited" -> RateLimited(reservations?.reason)
				"verification_failed" -> VerificationFailed
				"phone_overlap" -> PhoneOverlap
				"not_found" -> NotFound
				"invalid", "party_size_invalid" -> Invalid
				else -> when (api.statusCode) {
					429 -> RateLimited(reservations?.reason)
					410 -> HoldExpired
					404 -> NotFound
					else -> Other(api.message)
				}
			}
		}
	}
}

/** How the payment poll answer reads to a guest (mirrors `interpretPay` on Sites). */
enum class PayOutcome { PAID, EXPIRED, REVIEW, REFUNDED, FAILED, PENDING }

object PaymentPoll {
	val DELAYS_MS = longArrayOf(1_500, 2_500, 4_000, 6_000, 10_000)
	const val MAX_MS = 180_000L

	/** The delay before poll number [attempt] (0-based); the last delay repeats. */
	fun delayMs(attempt: Int): Long = DELAYS_MS[attempt.coerceIn(0, DELAYS_MS.size - 1)]

	private val PAID = setOf("paid", "guaranteed", "fee_charged")
	private val REFUNDED = setOf("refunded", "partially_refunded", "refund_pending")
	private val DEAD = setOf("cancelled", "expired", "declined", "no_show", "finished")

	fun interpret(status: ResPaymentStatus): PayOutcome = when {
		status.paymentStatus in PAID -> PayOutcome.PAID
		status.paymentStatus == "fee_failed" -> PayOutcome.FAILED
		status.paymentStatus == "review" || status.paymentStatus == "disputed" -> PayOutcome.REVIEW
		status.paymentStatus in REFUNDED -> PayOutcome.REFUNDED
		status.reservationStatus in DEAD -> PayOutcome.EXPIRED
		else -> PayOutcome.PENDING
	}
}

sealed interface FlowState {
	data object Idle : FlowState
	data class Searching(val selection: ResSelection) : FlowState

	/** [notice] carries the last hold failure (slot gone, rate limited, ...). */
	data class ChoosingTime(
		val selection: ResSelection,
		val availability: ResAvailability,
		val notice: FlowError? = null,
	) : FlowState

	data class Holding(val selection: ResSelection, val hold: ResHold) : FlowState
	data class Details(val selection: ResSelection, val hold: ResHold) : FlowState
	data class Reviewing(
		val selection: ResSelection,
		val hold: ResHold,
		val details: ResBookingDetails,
		val submitting: Boolean = false,
		val notice: FlowError? = null,
	) : FlowState

	data class AwaitingPayment(
		val booking: ResBooking,
		val outcome: PayOutcome = PayOutcome.PENDING,
	) : FlowState

	data class Confirmed(val booking: ResBooking) : FlowState
	data class Expired(val reason: FlowError?, val paymentExpired: Boolean = false) : FlowState
	data class Failed(val error: FlowError) : FlowState
}

/** Which manage actions the manage payload allows. */
data class ManageEligibility(val canModify: Boolean, val canCancel: Boolean, val canRunLate: Boolean) {
	companion object {
		fun of(view: ResManageView, deviceNowMs: Long) =
			ManageEligibility(view.canModify, view.canCancel, view.canRunLate(deviceNowMs))
	}
}

/**
 * The pure booking state machine: search -> choose time -> hold -> details ->
 * review -> (payment) -> confirmed, plus the waitlist. It performs no I/O and
 * reads no clock: callers pass the device time, so the hold countdown is the
 * server timeline (`expiresAt` and the server `now` seen with the hold), never
 * the device clock alone. The iOS `BookingFlow` has the same shape.
 */
class BookingFlow {
	var state: FlowState = FlowState.Idle
		private set

	/** Server `now` minus device `now`, measured when the hold arrived. */
	var clockOffsetMs: Long = 0
		private set

	/** The key of an attempt that ended in a network error; reused by the retry. */
	var pendingKey: String? = null
		private set

	private var lastSubmitted: ResBookingDetails? = null

	fun reset() {
		state = FlowState.Idle
		pendingKey = null
		lastSubmitted = null
		clockOffsetMs = 0
	}

	// MARK: - Search

	fun startSearch(selection: ResSelection) {
		state = FlowState.Searching(selection)
	}

	fun availabilityLoaded(selection: ResSelection, availability: ResAvailability) {
		state = FlowState.ChoosingTime(selection, availability)
	}

	fun searchFailed(error: Exception) {
		state = FlowState.Failed(FlowError.from(error))
	}

	/** Follows an alternative date: same party, new date, back to searching. */
	fun chooseAlternativeDate(date: String) {
		val selection = when (val s = state) {
			is FlowState.ChoosingTime -> s.selection
			is FlowState.Searching -> s.selection
			else -> return
		}
		state = FlowState.Searching(selection.copy(date = date))
	}

	// MARK: - Hold

	fun holdAcquired(selection: ResSelection, hold: ResHold, deviceNowMs: Long) {
		clockOffsetMs = hold.serverNowMs - deviceNowMs
		pendingKey = null
		lastSubmitted = null
		state = FlowState.Holding(selection, hold)
	}

	fun holdFailed(error: Exception) {
		val flowError = FlowError.from(error)
		val current = state as? FlowState.ChoosingTime
		if (current == null) {
			state = FlowState.Failed(flowError)
			return
		}
		val availability = if (flowError is FlowError.SlotUnavailable) {
			current.availability.copy(alternatives = flowError.alternatives)
		} else {
			current.availability
		}
		state = current.copy(availability = availability, notice = flowError)
	}

	fun beginDetails() {
		val s = state as? FlowState.Holding ?: return
		state = FlowState.Details(s.selection, s.hold)
	}

	fun review(details: ResBookingDetails) {
		val hold = holdOrNull() ?: return
		val selection = selectionOrNull() ?: return
		// Different details are a different request body: the old key would 409.
		if (details != lastSubmitted) pendingKey = null
		state = FlowState.Reviewing(selection, hold, details)
	}

	fun backToDetails() {
		val s = state as? FlowState.Reviewing ?: return
		state = FlowState.Details(s.selection, s.hold)
	}

	/** Milliseconds left on the hold on the server timeline; null without a hold. */
	fun holdRemainingMs(deviceNowMs: Long): Long? {
		val hold = holdOrNull() ?: return null
		return hold.expiresAtMs - (deviceNowMs + clockOffsetMs)
	}

	/** Moves to Expired when the hold ran out. Returns whether it did. */
	fun tick(deviceNowMs: Long): Boolean {
		val s = state
		val holding = s is FlowState.Holding || s is FlowState.Details ||
			(s is FlowState.Reviewing && !s.submitting)
		if (!holding) return false
		val remaining = holdRemainingMs(deviceNowMs) ?: return false
		if (remaining > 0) return false
		pendingKey = null
		state = FlowState.Expired(FlowError.HoldExpired)
		return true
	}

	// MARK: - Booking

	/** Starts (or retries) the booking; returns the idempotency key to send. */
	fun beginSubmit(newKey: () -> String): String? {
		val s = state as? FlowState.Reviewing ?: return null
		if (s.submitting) return null
		val key = pendingKey ?: newKey().also { pendingKey = it }
		lastSubmitted = s.details
		state = s.copy(submitting = true, notice = null)
		return key
	}

	fun bookingSucceeded(booking: ResBooking) {
		pendingKey = null
		state = if (booking.reservation.status == "pending_payment" && booking.payment != null) {
			FlowState.AwaitingPayment(booking)
		} else {
			FlowState.Confirmed(booking)
		}
	}

	/** A large-party request needs no hold and no review: the answer is the result. */
	fun requestSucceeded(booking: ResBooking) {
		pendingKey = null
		state = FlowState.Confirmed(booking)
	}

	fun bookingFailed(error: Exception) {
		val s = state as? FlowState.Reviewing ?: return
		val flowError = FlowError.from(error)
		when (flowError) {
			// The same request may have been stored: keep the key and retry safely.
			is FlowError.Network -> state = s.copy(submitting = false, notice = flowError)
			is FlowError.SlotUnavailable, is FlowError.HoldExpired -> {
				pendingKey = null
				state = FlowState.Expired(flowError)
			}
			else -> {
				pendingKey = null
				state = s.copy(submitting = false, notice = flowError)
			}
		}
	}

	// MARK: - Payment

	fun paymentPolled(status: ResPaymentStatus) {
		val s = state as? FlowState.AwaitingPayment ?: return
		state = when (val outcome = PaymentPoll.interpret(status)) {
			PayOutcome.PAID -> FlowState.Confirmed(
				s.booking.copy(paymentStatus = status.paymentStatus),
			)
			PayOutcome.EXPIRED -> FlowState.Expired(null, paymentExpired = true)
			else -> s.copy(outcome = outcome)
		}
	}

	// MARK: - Helpers

	private fun holdOrNull(): ResHold? = when (val s = state) {
		is FlowState.Holding -> s.hold
		is FlowState.Details -> s.hold
		is FlowState.Reviewing -> s.hold
		else -> null
	}

	private fun selectionOrNull(): ResSelection? = when (val s = state) {
		is FlowState.Holding -> s.selection
		is FlowState.Details -> s.selection
		is FlowState.Reviewing -> s.selection
		else -> null
	}
}

/** The waitlist half: a join result, then status answers until the party is done. */
class WaitlistFlow {
	var statusToken: String? = null
		private set
	var status: ResWaitlistStatus? = null
		private set
	var pendingKey: String? = null
		private set

	fun beginJoin(newKey: () -> String): String = pendingKey ?: newKey().also { pendingKey = it }

	fun joined(join: ResWaitlistJoin) {
		pendingKey = null
		statusToken = join.statusToken
		status = ResWaitlistStatus(
			status = join.status,
			position = join.position,
			partySize = join.partySize,
			quotedMin = join.quotedMin,
			canLeave = true,
			canOnMyWay = true,
		)
	}

	/** A network error keeps the key; any other answer ends the attempt. */
	fun joinFailed(error: Exception) {
		if (FlowError.from(error) !is FlowError.Network) pendingKey = null
	}

	fun statusUpdated(next: ResWaitlistStatus) {
		status = next
	}

	/** An unknown token (404) or a finished entry stops polling. */
	val isActive: Boolean get() = statusToken != null && status?.isActive == true

	fun clear() {
		statusToken = null
		status = null
		pendingKey = null
	}
}
