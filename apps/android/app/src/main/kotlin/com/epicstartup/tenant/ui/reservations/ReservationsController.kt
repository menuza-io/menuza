package com.epicstartup.tenant.ui.reservations

import android.os.Handler
import android.os.Looper
import com.epicstartup.tenant.core.net.ApiException
import com.epicstartup.tenant.core.reservations.BookingFlow
import com.epicstartup.tenant.core.reservations.FlowError
import com.epicstartup.tenant.core.reservations.FlowState
import com.epicstartup.tenant.core.reservations.PaymentPoll
import com.epicstartup.tenant.core.reservations.ReservationTokenKeys
import com.epicstartup.tenant.core.reservations.ReservationTokenStorage
import com.epicstartup.tenant.core.reservations.ReservationsClient
import com.epicstartup.tenant.core.reservations.ResAvailability
import com.epicstartup.tenant.core.reservations.ResBookingDetails
import com.epicstartup.tenant.core.reservations.ResConfig
import com.epicstartup.tenant.core.reservations.ResGuest
import com.epicstartup.tenant.core.reservations.ResLocation
import com.epicstartup.tenant.core.reservations.ResManageView
import com.epicstartup.tenant.core.reservations.ResMine
import com.epicstartup.tenant.core.reservations.ResSelection
import com.epicstartup.tenant.core.reservations.ResSlot
import com.epicstartup.tenant.core.reservations.WaitlistFlow
import com.epicstartup.tenant.platform.TaskRunner
import com.epicstartup.tenant.ui.AppState
import java.time.LocalDate
import java.time.ZoneId

/**
 * Drives the reservations screens: runs the [ReservationsClient] calls off the
 * main thread, feeds the pure [BookingFlow], and tells [AppState] to repaint.
 * All fields are read and written on the main thread (results are posted back by
 * [TaskRunner]). Guest details live in memory only, and tokens only in the
 * Keystore-backed [ReservationTokenStorage].
 */
internal class ReservationsController(
	private val app: AppState,
	private val client: ReservationsClient,
	private val storage: () -> ReservationTokenStorage,
) {
	val flow = BookingFlow()
	val waitlist = WaitlistFlow()

	var config: ResConfig? = null
		private set
	var mine: ResMine? = null
		private set
	var location: ResLocation? = null
		private set
	var selection: ResSelection? = null
		private set
	var loading = false
		private set
	var error: FlowError? = null
		private set

	/** Manage view of the open `res:detail:<id>` screen. */
	var detail: ResManageView? = null
		private set
	var detailAvailability: ResAvailability? = null
		private set
	var detailBusy = false
		private set

	/** A large-party request is being composed (no hold, no review). */
	var requestLocalMin: Int? = null
		private set
	var waitlistBusy = false
		private set
	var waitlistError: FlowError? = null
		private set

	val isAvailable: Boolean get() = config?.locations?.isNotEmpty() == true

	private val main = Handler(Looper.getMainLooper())
	private var tokens: Map<String, String>? = null
	private var pollGeneration = 0
	private var pollAttempt = 0
	private var pollStartedAt = 0L
	private var pollScheduled = false
	private var requestKey: String? = null

	private val ticker = object : Runnable {
		override fun run() {
			val expired = flow.tick(System.currentTimeMillis())
			if (expired) {
				showResult()
			} else if (holdActive()) {
				main.postDelayed(this, 1_000)
			}
			changed()
		}
	}

	// MARK: - Discovery

	fun loadConfig() {
		TaskRunner.run(
			work = { client.config(app.language.code) },
			onSuccess = {
				config = it
				changed()
			},
			// A paused or switched-off module answers 404/503: no entry point.
			onFailure = {
				config = null
				changed()
			},
		)
		ensureTokens()
	}

	fun openHome() {
		app.pushRes("res:home")
		loadMine()
	}

	fun loadMine() {
		TaskRunner.run(
			work = { client.mine() },
			onSuccess = { result ->
				mine = result
				// `/mine` hands back fresh manage tokens: cache them for next time.
				rememberTokens(result.upcoming.associate { ReservationTokenKeys.manage(it.summary.id) to it.manageToken })
				changed()
			},
			onFailure = { fail(it) },
		)
	}

	// MARK: - Search

	fun startBooking() {
		val locations = config?.locations.orEmpty()
		flow.reset()
		error = null
		if (locations.size == 1) selectLocation(locations.first()) else app.pushRes("res:location")
	}

	fun selectLocation(chosen: ResLocation) {
		location = chosen
		val zone = runCatching { ZoneId.of(chosen.timeZone) }.getOrDefault(ZoneId.systemDefault())
		val party = 2.coerceIn(chosen.partyMin, chosen.partyMax)
		selection = ResSelection(chosen.id, LocalDate.now(zone).toString(), party)
		app.pushRes("res:search")
		search()
	}

	/** Today in the location's own time zone (business dates are never device-zone). */
	fun today(): String {
		val zone = runCatching { ZoneId.of(location?.timeZone ?: "UTC") }.getOrDefault(ZoneId.systemDefault())
		return LocalDate.now(zone).toString()
	}

	fun setParty(partySize: Int) {
		val current = selection ?: return
		val loc = location ?: return
		selection = current.copy(partySize = partySize.coerceIn(loc.partyMin, loc.partyMax))
		search()
	}

	fun setDate(date: String) {
		selection = (selection ?: return).copy(date = date)
		search()
	}

	fun search() {
		val current = selection ?: return
		flow.startSearch(current)
		error = null
		changed()
		TaskRunner.run(
			work = { client.availability(current.locationId, current.date, current.partySize, locale = app.language.code) },
			onSuccess = {
				if (selection != current) return@run
				flow.availabilityLoaded(current, it)
				changed()
			},
			onFailure = {
				if (selection != current) return@run
				flow.searchFailed(it)
				changed()
			},
		)
	}

	// MARK: - Hold and booking

	fun chooseSlot(slot: ResSlot) {
		val current = selection ?: return
		val previous = holdTokenOrNull()
		loading = true
		changed()
		TaskRunner.run(
			work = {
				client.createHold(
					locationId = current.locationId,
					date = current.date,
					localMin = slot.localMin,
					partySize = current.partySize,
					serviceId = slot.serviceId,
					areaId = slot.areaId,
					replaceHoldToken = previous,
				)
			},
			onSuccess = { hold ->
				loading = false
				flow.holdAcquired(current, hold, System.currentTimeMillis())
				flow.beginDetails()
				requestLocalMin = null
				app.pushRes("res:details")
				startTicker()
				changed()
			},
			onFailure = {
				loading = false
				flow.holdFailed(it)
				changed()
			},
		)
	}

	fun guestIdentity(): ResGuest {
		val profile = app.profile
		val name = profile?.name.orEmpty().trim()
		val first = name.substringBefore(' ').ifEmpty { name }
		return ResGuest(
			firstName = first,
			lastName = name.removePrefix(first).trim(),
			phone = profile?.phone.orEmpty(),
			email = profile?.email,
		)
	}

	fun reviewDetails(details: ResBookingDetails) {
		if (requestLocalMin != null) {
			submitRequest(details)
			return
		}
		flow.review(details)
		app.pushRes("res:review")
		changed()
	}

	fun backFromReview() {
		flow.backToDetails()
	}

	fun confirmBooking() {
		val key = flow.beginSubmit(ReservationsClient::newIdempotencyKey) ?: return
		val state = flow.state as? FlowState.Reviewing ?: return
		changed()
		TaskRunner.run(
			work = { client.book(state.hold.holdToken, state.details, key) },
			onSuccess = { booking ->
				stopTicker()
				rememberTokens(mapOf(ReservationTokenKeys.manage(booking.reservation.id) to booking.manageToken))
				flow.bookingSucceeded(booking)
				showResult()
				startPaymentPolling()
				changed()
			},
			onFailure = {
				flow.bookingFailed(it)
				if (flow.state is FlowState.Expired) {
					stopTicker()
					showResult()
				}
				changed()
			},
		)
	}

	fun startRequest(localMin: Int) {
		requestLocalMin = localMin
		flow.reset()
		app.pushRes("res:details")
		changed()
	}

	private fun submitRequest(details: ResBookingDetails) {
		val current = selection ?: return
		val loc = location ?: return
		val localMin = requestLocalMin ?: return
		val key = requestKey ?: ReservationsClient.newIdempotencyKey().also { requestKey = it }
		loading = true
		error = null
		changed()
		TaskRunner.run(
			work = {
				client.requestLargeParty(loc.id, current.date, localMin, current.partySize, details, key)
			},
			onSuccess = { booking ->
				loading = false
				requestKey = null
				requestLocalMin = null
				rememberTokens(mapOf(ReservationTokenKeys.manage(booking.reservation.id) to booking.manageToken))
				flow.requestSucceeded(booking)
				showResult()
				changed()
			},
			onFailure = {
				loading = false
				error = FlowError.from(it)
				// A network error keeps the key so the retry cannot book twice.
				if (error != FlowError.Network) requestKey = null
				changed()
			},
		)
	}

	/** Leaving the booking before it is made frees the table straight away. */
	fun abandonHold() {
		stopTicker()
		holdTokenOrNull()?.let { token -> TaskRunner.run(work = { client.releaseHold(token) }) }
		flow.reset()
	}

	fun finishFlow() {
		stopPolling()
		stopTicker()
		flow.reset()
		requestLocalMin = null
		app.popResTo("res:home")
		loadMine()
	}

	private fun showResult() {
		app.replaceRes("res:confirmed")
	}

	private fun holdTokenOrNull(): String? = when (val s = flow.state) {
		is FlowState.Holding -> s.hold.holdToken
		is FlowState.Details -> s.hold.holdToken
		is FlowState.Reviewing -> s.hold.holdToken
		else -> null
	}

	private fun holdActive(): Boolean = when (val s = flow.state) {
		is FlowState.Holding, is FlowState.Details -> true
		is FlowState.Reviewing -> !s.submitting
		else -> false
	}

	fun startTicker() {
		main.removeCallbacks(ticker)
		main.postDelayed(ticker, 1_000)
	}

	fun stopTicker() = main.removeCallbacks(ticker)

	/** Back on a reservations screen; false when the profile should handle it. */
	fun onBack(): Boolean {
		val top = app.resStack.lastOrNull() ?: return false
		when {
			top == "res:details" -> {
				if (requestLocalMin == null) abandonHold()
				requestLocalMin = null
			}
			top == "res:review" -> backFromReview()
			top == "res:confirmed" -> {
				finishFlow()
				return true
			}
			top == "res:search" -> flow.reset()
		}
		return app.popRes()
	}

	// MARK: - Payment

	/** Call from `onResume`: the guest may just have come back from the browser. */
	fun onResume() {
		if (flow.state is FlowState.AwaitingPayment) startPaymentPolling(immediate = true)
		if (app.resStack.lastOrNull()?.startsWith("res:detail:") == true) detail?.let { reloadDetail() }
		if (holdActive()) startTicker()
	}

	fun startPaymentPolling(immediate: Boolean = false) {
		val state = flow.state as? FlowState.AwaitingPayment ?: return
		pollAttempt = 0
		pollStartedAt = System.currentTimeMillis()
		if (!pollScheduled || immediate) schedulePoll(if (immediate) 0 else PaymentPoll.delayMs(0), state)
	}

	fun stopPolling() {
		pollGeneration += 1
		pollScheduled = false
		main.removeCallbacksAndMessages(POLL_TOKEN)
	}

	private fun schedulePoll(delayMs: Long, state: FlowState.AwaitingPayment) {
		val attempt = pollGeneration
		pollScheduled = true
		main.removeCallbacksAndMessages(POLL_TOKEN)
		main.postAtTime(
			{ pollOnce(attempt, state) },
			POLL_TOKEN,
			android.os.SystemClock.uptimeMillis() + delayMs,
		)
	}

	private fun pollOnce(attempt: Int, state: FlowState.AwaitingPayment) {
		if (attempt != pollGeneration) return
		TaskRunner.run(
			work = { client.paymentStatus(state.booking.payment?.paymentToken ?: state.booking.manageToken) },
			onSuccess = { status ->
				if (attempt != pollGeneration) return@run
				flow.paymentPolled(status)
				changed()
				continuePolling(attempt)
			},
			onFailure = { failure ->
				if (attempt != pollGeneration) return@run
				val api = failure as? ApiException
				// 401/403/404 are final: the link is dead. Anything else may pass.
				if (api != null && api.statusCode in setOf(401, 403, 404)) {
					pollScheduled = false
					return@run
				}
				continuePolling(attempt)
			},
		)
	}

	private fun continuePolling(attempt: Int) {
		val state = flow.state as? FlowState.AwaitingPayment
		val elapsed = System.currentTimeMillis() - pollStartedAt
		// A failed charge is final until the guest pays again, so stop polling.
		if (state == null || state.outcome == PayOutcome.FAILED || elapsed >= PaymentPoll.MAX_MS) {
			pollScheduled = false
			return
		}
		pollAttempt += 1
		if (attempt == pollGeneration) schedulePoll(PaymentPoll.delayMs(pollAttempt), state)
	}

	// MARK: - Manage

	fun openDetail(id: String) {
		detail = null
		detailAvailability = null
		error = null
		app.pushRes("res:detail:$id")
		loadDetail(id)
	}

	private fun reloadDetail() {
		detail?.reservation?.id?.let { loadDetail(it) }
	}

	private fun loadDetail(id: String) {
		withToken(ReservationTokenKeys.manage(id)) { token ->
			if (token == null) {
				error = FlowError.NotFound
				changed()
				return@withToken
			}
			TaskRunner.run(
				work = { client.manage(token) },
				onSuccess = {
					detail = it
					changed()
				},
				onFailure = { fail(it) },
			)
		}
	}

	fun loadDetailAvailability(date: String, partySize: Int) {
		val view = detail ?: return
		withToken(ReservationTokenKeys.manage(view.reservation.id)) { token ->
			token ?: return@withToken
			TaskRunner.run(
				work = { client.manageAvailability(token, date, partySize) },
				onSuccess = {
					detailAvailability = it
					changed()
				},
				onFailure = { fail(it) },
			)
		}
	}

	fun modify(date: String, localMin: Int, partySize: Int) =
		manageAction { client.modify(it, date, localMin, partySize) }

	fun cancelReservation() = manageAction { client.cancel(it) }

	fun runningLate(minutes: Int) = manageAction { client.runningLate(it, minutes) }

	private fun manageAction(call: (String) -> ResManageView) {
		val view = detail ?: return
		detailBusy = true
		error = null
		changed()
		withToken(ReservationTokenKeys.manage(view.reservation.id)) { token ->
			if (token == null) {
				detailBusy = false
				error = FlowError.NotFound
				changed()
				return@withToken
			}
			TaskRunner.run(
				work = { call(token) },
				onSuccess = {
					detailBusy = false
					detail = it
					detailAvailability = null
					changed()
				},
				onFailure = {
					detailBusy = false
					fail(it)
				},
			)
		}
	}

	// MARK: - Waitlist

	fun openWaitlist() {
		val loc = location ?: return
		waitlistError = null
		app.pushRes("res:waitlist")
		withToken(ReservationTokenKeys.waitlist(loc.id)) { token ->
			if (token != null && waitlist.statusToken == null) refreshWaitlist(token)
			changed()
		}
	}

	fun joinWaitlist(name: String, partySize: Int, smsOptIn: Boolean) {
		val loc = location ?: return
		val phone = app.profile?.phone.orEmpty()
		val key = waitlist.beginJoin(ReservationsClient::newIdempotencyKey)
		waitlistBusy = true
		waitlistError = null
		changed()
		TaskRunner.run(
			work = {
				client.joinWaitlist(loc.id, name, partySize, phone, smsOptIn, app.language.code, key)
			},
			onSuccess = {
				waitlistBusy = false
				waitlist.joined(it)
				rememberTokens(mapOf(ReservationTokenKeys.waitlist(loc.id) to it.statusToken))
				changed()
			},
			onFailure = {
				waitlistBusy = false
				waitlist.joinFailed(it)
				waitlistError = FlowError.from(it)
				changed()
			},
		)
	}

	fun refreshWaitlist(token: String? = waitlist.statusToken) {
		token ?: return
		TaskRunner.run(
			work = { client.waitlistStatus(token) },
			onSuccess = {
				waitlist.statusUpdated(it)
				changed()
			},
			onFailure = {
				val api = it as? ApiException
				// A dead or expired link: forget it so the guest can join again.
				if (api?.statusCode == 404) forgetWaitlist()
				waitlistError = FlowError.from(it)
				changed()
			},
		)
	}

	fun leaveWaitlist() = waitlistAction { client.leaveWaitlist(it) }

	fun waitlistOnMyWay() = waitlistAction { client.waitlistOnMyWay(it) }

	private fun waitlistAction(call: (String) -> com.epicstartup.tenant.core.reservations.ResWaitlistStatus) {
		val token = waitlist.statusToken ?: return
		waitlistBusy = true
		changed()
		TaskRunner.run(
			work = { call(token) },
			onSuccess = {
				waitlistBusy = false
				waitlist.statusUpdated(it)
				changed()
			},
			onFailure = {
				waitlistBusy = false
				waitlistError = FlowError.from(it)
				changed()
			},
		)
	}

	private fun forgetWaitlist() {
		val id = location?.id ?: return
		waitlist.clear()
		rememberTokens(emptyMap(), remove = setOf(ReservationTokenKeys.waitlist(id)))
	}

	// MARK: - Tokens

	private fun ensureTokens() {
		if (tokens != null) return
		TaskRunner.run(
			work = { storage().load() },
			onSuccess = { if (tokens == null) tokens = it },
		)
	}

	private fun withToken(key: String, block: (String?) -> Unit) {
		val known = tokens
		if (known != null) {
			block(known[key])
			return
		}
		TaskRunner.run(
			work = { storage().load() },
			onSuccess = {
				if (tokens == null) tokens = it
				block(tokens?.get(key))
			},
			onFailure = { block(null) },
		)
	}

	private fun rememberTokens(add: Map<String, String>, remove: Set<String> = emptySet()) {
		val merged = ((tokens ?: emptyMap()) + add) - remove
		tokens = merged
		TaskRunner.run(work = { storage().save(merged) })
	}

	/** Sign-out: bookings belong to the customer, so their tokens go with the session. */
	fun onSignedOut() {
		stopPolling()
		stopTicker()
		flow.reset()
		waitlist.clear()
		config = null
		mine = null
		detail = null
		detailAvailability = null
		location = null
		selection = null
		error = null
		tokens = emptyMap()
		TaskRunner.run(work = { storage().save(emptyMap()) })
	}

	private fun fail(failure: Exception) {
		error = FlowError.from(failure)
		changed()
	}

	private fun changed() = app.notifyReservationsChanged()

	private companion object {
		val POLL_TOKEN = Any()
	}
}
