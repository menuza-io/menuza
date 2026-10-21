package com.epicstartup.tenant.ui.reservations

import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.text.InputType
import android.view.View
import android.widget.LinearLayout
import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.reservations.FlowState
import com.epicstartup.tenant.core.reservations.PayOutcome
import com.epicstartup.tenant.core.reservations.ResBookingDetails
import com.epicstartup.tenant.core.reservations.ResSummary
import com.epicstartup.tenant.ui.components.FormMessage
import com.epicstartup.tenant.ui.components.PrimaryButton
import com.epicstartup.tenant.ui.components.SecondaryButton
import com.epicstartup.tenant.ui.components.ThemedCard
import com.epicstartup.tenant.ui.components.ThemedTextField
import com.epicstartup.tenant.ui.components.dp
import com.epicstartup.tenant.ui.screens.Screen
import com.epicstartup.tenant.ui.screens.ScreenHost
import com.epicstartup.tenant.ui.screens.addSpaced
import com.epicstartup.tenant.ui.screens.screenColumn
import com.epicstartup.tenant.ui.screens.screenScroll
import java.time.LocalDate

// The reservations screens, behind the `res:*` keys in AppState/MainActivity.
// Each one reads `ReservationsController` and never touches the network itself.

private val ScreenHost.rc: ReservationsController get() = state.reservations!!
private val ScreenHost.tag: String get() = state.language.code
private fun ScreenHost.str(id: Int, vararg args: Any): String = uiContext.getString(id, *args)

/** Shared layout: a scrolling column of cards, rebuilt content refreshed by `update()`. */
internal abstract class ResScreen(protected val host: ScreenHost) : Screen {
	protected val ctx = host.uiContext
	protected val palette = host.palette
	protected val card = ThemedCard(ctx, palette)
	protected val body = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
	protected val message = FormMessage(ctx, palette)
	private val column = ctx.screenColumn().apply { addSpaced(card, 0) }
	override val view: View = ctx.screenScroll(column)

	init {
		card.addView(body)
	}

	/** Adds another card below the main one. */
	protected fun extraCard(): ThemedCard = ThemedCard(ctx, palette).also { column.addSpaced(it, ctx.dp(20f)) }

	protected fun summaryLine(summary: ResSummary): String =
		listOfNotNull(
			ResFormat.date(summary.date, host.tag),
			ResFormat.time(summary.localMin, host.tag),
			host.str(R.string.res_party_of, summary.partySize),
		).joinToString(" · ")

	protected fun primary(title: String, loading: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) =
		PrimaryButton(ctx, palette).apply { bind(title, loading, enabled, onClick) }

	protected fun secondary(title: String, onClick: () -> Unit) =
		SecondaryButton(ctx, palette).apply {
			text = title
			setOnClickListener { onClick() }
		}
}

// MARK: - Home

internal class ResHomeScreen(host: ScreenHost) : ResScreen(host) {
	private val list = extraCard()

	override fun update() {
		body.removeAllViews()
		body.addRow(ctx.headingText(palette, host.str(R.string.res_title)))
		body.addRow(primary(host.str(R.string.res_book_table)) { host.rc.startBooking() }, 16f)

		list.removeAllViews()
		list.addView(ctx.headingText(palette, host.str(R.string.res_my_reservations)))
		val error = host.rc.error
		val mine = host.rc.mine
		when {
			mine == null && error == null -> list.addRow(ctx.bodyText(palette, host.str(R.string.app_loading), muted = true))
			mine == null -> list.addRow(ctx.bodyText(palette, host.str(ResFormat.errorRes(error!!)), muted = true))
			mine.upcoming.isEmpty() -> list.addRow(ctx.bodyText(palette, host.str(R.string.res_none_upcoming), muted = true))
			else -> mine.upcoming.forEach { item ->
				val s = item.summary
				list.addRow(
					ctx.listRow(
						palette,
						s.locationName ?: host.str(R.string.res_title),
						host.str(ResFormat.statusRes(s.status)) + " \u00B7 " + summaryLine(s),
					) { host.rc.openDetail(s.id) },
				)
			}
		}
	}
}

// MARK: - Location

internal class ResLocationScreen(host: ScreenHost) : ResScreen(host) {
	override fun update() {
		body.removeAllViews()
		body.addRow(ctx.headingText(palette, host.str(R.string.res_choose_location)))
		host.rc.config?.locations.orEmpty().forEach { location ->
			body.addRow(ctx.listRow(palette, location.name, location.address) { host.rc.selectLocation(location) }, 12f)
		}
	}
}

// MARK: - Search

internal class ResSearchScreen(host: ScreenHost) : ResScreen(host) {
	private val stepper = Stepper(ctx, palette) { host.rc.setParty(it) }
	private val dates = ChipGrid(ctx, palette, perRow = 4)
	private val times = ChipGrid(ctx, palette, perRow = 4)
	private val others = ChipGrid(ctx, palette, perRow = 3)
	private val extra = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }

	override fun update() {
		val rc = host.rc
		val location = rc.location ?: return
		val selection = rc.selection ?: return
		body.removeAllViews()
		body.addRow(ctx.headingText(palette, location.name))
		body.addRow(ctx.bodyText(palette, host.str(R.string.res_party_size), bold = true), 16f)
		stepper.bind(selection.partySize, location.partyMin, location.partyCeiling)
		body.addRow(stepper, 8f)
		if (location.needsApproval(selection.partySize)) {
			body.addRow(
				ctx.bodyText(palette, host.str(R.string.res_party_over_max, location.partyMax), muted = true),
				6f,
			)
		}

		body.addRow(ctx.bodyText(palette, host.str(R.string.res_date), bold = true), 16f)
		val start = runCatching { LocalDate.parse(rc.today()) }.getOrDefault(LocalDate.now())
		val days = (0 until 3).map { start.plusDays(it.toLong()).toString() }
		val labels = days.map { ResFormat.dayNumber(it, host.tag) } + host.str(R.string.res_more_dates)
		dates.bind(labels, days.indexOf(selection.date)) { index ->
			if (index < days.size) rc.setDate(days[index]) else pickDate(start, location.horizonDays)
		}
		body.addRow(dates, 8f)
		body.addRow(
			ctx.bodyText(palette, ResFormat.date(selection.date, host.tag), muted = true),
			6f,
		)

		body.addRow(ctx.bodyText(palette, host.str(R.string.res_choose_time), bold = true), 16f)
		extra.removeAllViews()
		when (val state = rc.flow.state) {
			is FlowState.Searching -> extra.addRow(ctx.bodyText(palette, host.str(R.string.app_loading), muted = true))
			is FlowState.ChoosingTime -> showTimes(state)
			is FlowState.Failed -> {
				extra.addRow(ctx.bodyText(palette, host.str(ResFormat.errorRes(state.error)), muted = true))
				extra.addRow(secondary(host.str(R.string.app_retry)) { rc.search() })
			}
			else -> Unit
		}
		body.addRow(extra, 8f)
	}

	private fun showTimes(state: FlowState.ChoosingTime) {
		val rc = host.rc
		val availability = state.availability
		val location = rc.location ?: return
		state.notice?.let { extra.addRow(ctx.bodyText(palette, host.str(ResFormat.errorRes(it)), muted = true)) }

		if (availability.status == "large_party") {
			extra.addRow(ctx.bodyText(palette, host.str(R.string.res_large_party), muted = true))
			availability.largePartyPhone?.let { extra.addRow(ctx.bodyText(palette, it, bold = true), 6f) }
			if (location.largePartyMode == "request") {
				extra.addRow(primary(host.str(R.string.res_request_table)) { pickRequestTime() }, 12f)
			}
		}
		val slots = availability.slots.distinctBy { it.localMin }
		if (slots.isNotEmpty()) {
			times.bind(slots.map { ResFormat.time(it.localMin, host.tag) }, onClick = { rc.chooseSlot(slots[it]) })
			extra.addRow(times, 4f)
		} else if (availability.status != "large_party") {
			extra.addRow(ctx.bodyText(palette, host.str(R.string.res_no_times), muted = true))
		}

		val alternatives = availability.alternatives
		val showAlternatives = !alternatives.isEmpty &&
			(slots.isEmpty() || state.notice is com.epicstartup.tenant.core.reservations.FlowError.SlotUnavailable)
		if (showAlternatives) {
			if (alternatives.sameDay.isNotEmpty()) {
				extra.addRow(ctx.bodyText(palette, host.str(R.string.res_try_instead), bold = true), 16f)
				val same = alternatives.sameDay.distinctBy { it.localMin }
				val altTimes = ChipGrid(ctx, palette)
				altTimes.bind(same.map { ResFormat.time(it.localMin, host.tag) }) { rc.chooseSlot(same[it]) }
				extra.addRow(altTimes, 8f)
			}
			if (alternatives.otherDates.isNotEmpty()) {
				extra.addRow(ctx.bodyText(palette, host.str(R.string.res_other_dates), bold = true), 16f)
				val dates = alternatives.otherDates.take(6)
				others.bind(dates.map { ResFormat.date(it.date, host.tag) }) { rc.setDate(dates[it].date) }
				extra.addRow(others, 8f)
			}
		}
		if (availability.waitlist && location.waitlistOnline) {
			extra.addRow(secondary(host.str(R.string.res_waitlist_join)) { rc.openWaitlist() }, 16f)
		}
	}

	private fun pickDate(start: LocalDate, horizonDays: Int) {
		val current = runCatching { LocalDate.parse(host.rc.selection?.date) }.getOrDefault(start)
		val dialog = DatePickerDialog(
			host.activityContext,
			{ _, year, month, day -> host.rc.setDate(LocalDate.of(year, month + 1, day).toString()) },
			current.year,
			current.monthValue - 1,
			current.dayOfMonth,
		)
		val zero = start.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
		dialog.datePicker.minDate = zero
		dialog.datePicker.maxDate = zero + horizonDays * 86_400_000L
		dialog.show()
	}

	private fun pickRequestTime() {
		TimePickerDialog(
			host.activityContext,
			{ _, hour, minute -> host.rc.startRequest(hour * 60 + minute) },
			19,
			0,
			android.text.format.DateFormat.is24HourFormat(host.activityContext),
		).show()
	}
}

// MARK: - Details

internal class ResDetailsScreen(host: ScreenHost) : ResScreen(host) {
	private val requests = ThemedTextField(
		context = ctx,
		palette = palette,
		label = host.str(R.string.res_requests),
		placeholder = "",
		inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
	)
	private val sms = ctx.themedCheckBox(palette, host.str(R.string.res_sms_opt_in))
	private val consent = ctx.themedCheckBox(palette, host.str(R.string.res_policy_consent))
	private val countdown = ctx.bodyText(palette, "", 14f, bold = true)
	private val policy = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
	private val action = PrimaryButton(ctx, palette)
	private var built = false

	override fun update() {
		val rc = host.rc
		val state = rc.flow.state
		val hold = (state as? FlowState.Details)?.hold ?: (state as? FlowState.Holding)?.hold
		val selection = rc.selection
		if (!built) {
			built = true
			body.addRow(ctx.headingText(palette, host.str(R.string.res_details_title)))
			body.addRow(countdown, 8f)
			body.addRow(policy, 12f)
			body.addRow(requests, 16f)
			body.addRow(sms, 12f)
			body.addRow(consent, 8f)
			body.addRow(message, 12f)
			body.addRow(action, 16f)
		}
		val remaining = rc.flow.holdRemainingMs(System.currentTimeMillis())
		countdown.visibility = if (remaining == null) View.GONE else View.VISIBLE
		if (remaining != null) countdown.text = host.str(R.string.res_hold_countdown, ResFormat.countdown(remaining))

		policy.removeAllViews()
		val terms = hold?.policy
		if (terms != null) {
			policy.addRow(
				ctx.bodyText(
					palette,
					host.str(R.string.res_policy_amount, ResFormat.money(terms.totalAmountMinor, terms.currency, host.tag)),
					bold = true,
				),
			)
			terms.terms?.let { policy.addRow(ctx.bodyText(palette, it, 13f, muted = true), 6f) }
		}
		consent.visibility = if (terms != null) View.VISIBLE else View.GONE

		message.bind(rc.error?.let { host.str(ResFormat.errorRes(it)) })
		action.bind(host.str(R.string.res_continue), rc.loading, selection != null) {
			if (terms != null && !consent.isChecked) {
				message.bind(host.str(R.string.res_err_policy))
				return@bind
			}
			val guest = rc.guestIdentity()
			if (guest.phone.isBlank() || guest.firstName.isBlank()) {
				message.bind(host.str(R.string.res_err_verify))
				return@bind
			}
			rc.reviewDetails(
				ResBookingDetails(
					guest = guest,
					locale = host.tag,
					requests = requests.text.trim().ifEmpty { null },
					smsOptIn = sms.isChecked,
					policyTermsVersion = if (terms != null && consent.isChecked) terms.termsVersion else null,
				),
			)
		}
	}
}

// MARK: - Review

internal class ResReviewScreen(host: ScreenHost) : ResScreen(host) {
	override fun update() {
		val rc = host.rc
		val state = rc.flow.state as? FlowState.Reviewing ?: return
		body.removeAllViews()
		body.addRow(ctx.headingText(palette, host.str(R.string.res_review_title)))
		rc.flow.holdRemainingMs(System.currentTimeMillis())?.let {
			body.addRow(ctx.bodyText(palette, host.str(R.string.res_hold_countdown, ResFormat.countdown(it)), bold = true), 8f)
		}
		rc.location?.let { body.addRow(ctx.bodyText(palette, it.name, 15f, bold = true), 12f) }
		body.addRow(
			ctx.bodyText(
				palette,
				listOf(
					ResFormat.date(state.hold.date, host.tag),
					ResFormat.time(state.hold.localMin, host.tag),
					host.str(R.string.res_party_of, state.hold.partySize),
				).joinToString(" · "),
			),
			4f,
		)
		body.addRow(ctx.bodyText(palette, state.details.guest.firstName, muted = true), 4f)
		state.hold.policy?.let {
			body.addRow(
				ctx.bodyText(palette, host.str(R.string.res_policy_amount, ResFormat.money(it.totalAmountMinor, it.currency, host.tag)), bold = true),
				12f,
			)
		}
		message.bind(state.notice?.let { host.str(ResFormat.errorRes(it)) })
		body.addRow(message, 12f)
		body.addRow(
			primary(host.str(R.string.res_confirm), loading = state.submitting) { rc.confirmBooking() },
			16f,
		)
		body.addRow(secondary(host.str(R.string.res_edit)) { rc.onBack() }, 12f)
	}
}

// MARK: - Result (confirmed, awaiting payment, expired)

internal class ResConfirmedScreen(host: ScreenHost) : ResScreen(host) {
	override fun update() {
		val rc = host.rc
		body.removeAllViews()
		when (val state = rc.flow.state) {
			is FlowState.Confirmed -> {
				val booking = state.booking
				val requested = booking.reservation.status == "requested"
				body.addRow(ctx.headingText(palette, host.str(if (requested) R.string.res_requested_title else R.string.res_confirmed_title)))
				if (requested) body.addRow(ctx.bodyText(palette, host.str(R.string.res_requested_note), muted = true), 6f)
				summary(booking.reservation)
				body.addRow(secondary(host.str(R.string.res_view_reservation)) {
					val id = booking.reservation.id
					rc.finishFlow()
					rc.openDetail(id)
				}, 16f)
			}
			is FlowState.AwaitingPayment -> {
				val booking = state.booking
				body.addRow(ctx.headingText(palette, host.str(R.string.res_pay_title)))
				summary(booking.reservation)
				booking.payment?.let { pay ->
					body.addRow(
						ctx.bodyText(palette, ResFormat.money(pay.amountMinor, pay.currency, host.tag), 20f, bold = true),
						12f,
					)
					body.addRow(primary(host.str(R.string.res_pay_now)) { host.openUrl(pay.payUrl) }, 12f)
				}
				val note = when (state.outcome) {
					PayOutcome.REVIEW -> R.string.res_payment_review
					PayOutcome.REFUNDED -> R.string.res_payment_refunded
					PayOutcome.FAILED -> R.string.res_payment_failed
					else -> R.string.res_awaiting_payment
				}
				body.addRow(ctx.bodyText(palette, host.str(note), muted = true), 12f)
			}
			is FlowState.Expired -> {
				body.addRow(ctx.headingText(palette, host.str(R.string.res_expired_title)))
				val note = when {
					state.paymentExpired -> R.string.res_expired_payment
					state.reason != null && state.reason != com.epicstartup.tenant.core.reservations.FlowError.HoldExpired ->
						ResFormat.errorRes(state.reason)
					else -> R.string.res_expired_hold
				}
				body.addRow(ctx.bodyText(palette, host.str(note), muted = true), 6f)
			}
			else -> Unit
		}
		body.addRow(primary(host.str(R.string.res_done)) { rc.finishFlow() }, 12f)
	}

	private fun summary(summary: ResSummary) {
		body.addRow(ctx.bodyText(palette, summary.locationName.orEmpty(), 15f, bold = true), 12f)
		body.addRow(ctx.bodyText(palette, summaryLine(summary)), 4f)
		body.addRow(ctx.bodyText(palette, host.str(R.string.res_confirmation_code), muted = true), 12f)
		body.addRow(ctx.bodyText(palette, summary.confirmationCode, 20f, bold = true), 2f)
	}
}

// MARK: - Reservation detail (manage)

internal class ResDetailScreen(host: ScreenHost, private val id: String) : ResScreen(host) {
	private var modifying = false
	private var modifyDate: String? = null
	private var modifyParty = 0
	private val modifyStepper = Stepper(ctx, palette) { modifyParty = it; host.rc.loadDetailAvailability(modifyDate.orEmpty(), it) }
	private val slotGrid = ChipGrid(ctx, palette)

	override fun update() {
		val rc = host.rc
		body.removeAllViews()
		val view = rc.detail?.takeIf { it.reservation.id == id }
		if (view == null) {
			val error = rc.error
			body.addRow(
				ctx.bodyText(palette, host.str(if (error != null) ResFormat.errorRes(error) else R.string.app_loading), muted = true),
			)
			return
		}
		val s = view.reservation
		body.addRow(ctx.headingText(palette, s.locationName.orEmpty()))
		body.addRow(ctx.bodyText(palette, host.str(ResFormat.statusRes(s.status)), 14f, bold = true), 4f)
		body.addRow(ctx.bodyText(palette, summaryLine(s)), 8f)
		view.locationAddress?.let { body.addRow(ctx.bodyText(palette, it, 13f, muted = true), 4f) }
		body.addRow(ctx.bodyText(palette, host.str(R.string.res_confirmation_code) + ": " + s.confirmationCode, 13f, muted = true), 8f)
		view.runningLateMin?.let { body.addRow(ctx.bodyText(palette, host.str(R.string.res_late_sent, it), 13f, muted = true), 8f) }
		view.cancelDeadlineMs?.let {
			if (view.canModify || view.canCancel) {
				val deadline = java.time.Instant.ofEpochMilli(it)
					.atZone(runCatching { java.time.ZoneId.of(s.timeZone) }.getOrDefault(java.time.ZoneOffset.UTC))
				val label = ResFormat.date(deadline.toLocalDate().toString(), host.tag) + " " +
					ResFormat.time(deadline.hour * 60 + deadline.minute, host.tag)
				body.addRow(ctx.bodyText(palette, host.str(R.string.res_free_until, label), 13f, muted = true), 4f)
			}
		}
		message.bind(rc.error?.let { host.str(ResFormat.errorRes(it)) })
		body.addRow(message, 8f)

		val busy = rc.detailBusy
		val eligibility = com.epicstartup.tenant.core.reservations.ManageEligibility.of(view, System.currentTimeMillis())
		if (eligibility.canModify) {
			body.addRow(
				primary(host.str(R.string.res_modify), enabled = !busy) {
					modifying = !modifying
					modifyDate = s.date
					modifyParty = s.partySize
					if (modifying) rc.loadDetailAvailability(s.date, s.partySize)
					update()
				},
				12f,
			)
			if (modifying) modifyPanel(s)
		}
		if (eligibility.canRunLate) body.addRow(secondary(host.str(R.string.res_running_late)) { pickLate() }, 12f)
		if (eligibility.canCancel) body.addRow(secondary(host.str(R.string.res_cancel)) { confirmCancel() }, 12f)
	}

	private fun modifyPanel(s: ResSummary) {
		val rc = host.rc
		val date = modifyDate ?: s.date
		body.addRow(ctx.bodyText(palette, host.str(R.string.res_party_size), bold = true), 12f)
		modifyStepper.bind(modifyParty, 1, rc.location?.partyMax ?: 12)
		body.addRow(modifyStepper, 6f)
		body.addRow(secondary(ResFormat.date(date, host.tag)) {
			val current = runCatching { LocalDate.parse(date) }.getOrDefault(LocalDate.now())
			DatePickerDialog(
				host.activityContext,
				{ _, year, month, day ->
					modifyDate = LocalDate.of(year, month + 1, day).toString()
					rc.loadDetailAvailability(modifyDate.orEmpty(), modifyParty)
					update()
				},
				current.year,
				current.monthValue - 1,
				current.dayOfMonth,
			).show()
		}, 12f)
		val slots = rc.detailAvailability?.slots.orEmpty().distinctBy { it.localMin }
		if (slots.isEmpty()) {
			body.addRow(ctx.bodyText(palette, host.str(R.string.res_no_times), muted = true), 12f)
		} else {
			slotGrid.bind(slots.map { ResFormat.time(it.localMin, host.tag) }) { index ->
				val slot = slots[index]
				AlertDialog.Builder(host.activityContext)
					.setMessage(host.str(R.string.res_modify_confirm, ResFormat.date(date, host.tag) + " " + ResFormat.time(slot.localMin, host.tag)))
					.setPositiveButton(R.string.res_modify) { _, _ ->
						modifying = false
						rc.modify(date, slot.localMin, modifyParty)
					}
					.setNegativeButton(R.string.res_keep, null)
					.show()
			}
			body.addRow(slotGrid, 12f)
		}
	}

	private fun pickLate() {
		val options = intArrayOf(5, 10, 15, 30)
		AlertDialog.Builder(host.activityContext)
			.setTitle(R.string.res_running_late)
			.setItems(options.map { host.str(R.string.res_late_minutes, it) }.toTypedArray()) { _, which ->
				host.rc.runningLate(options[which])
			}
			.show()
	}

	private fun confirmCancel() {
		AlertDialog.Builder(host.activityContext)
			.setMessage(R.string.res_cancel_confirm)
			.setPositiveButton(R.string.res_cancel) { _, _ -> host.rc.cancelReservation() }
			.setNegativeButton(R.string.res_keep, null)
			.show()
	}
}

// MARK: - Waitlist

internal class ResWaitlistScreen(host: ScreenHost) : ResScreen(host) {
	private var party = 2
	private val stepper = Stepper(ctx, palette) { party = it }
	private val sms = ctx.themedCheckBox(palette, host.str(R.string.res_sms_opt_in))

	override fun update() {
		val rc = host.rc
		val location = rc.location ?: return
		body.removeAllViews()
		body.addRow(ctx.headingText(palette, host.str(R.string.res_waitlist_title)))
		val status = rc.waitlist.status
		val error = rc.waitlistError?.let { host.str(ResFormat.errorRes(it)) }
		if (rc.waitlist.statusToken == null) {
			body.addRow(ctx.bodyText(palette, host.str(R.string.res_waitlist_subtitle), muted = true), 6f)
			party = party.coerceIn(location.partyMin, location.partyMax)
			stepper.bind(party, location.partyMin, location.partyMax)
			body.addRow(ctx.bodyText(palette, host.str(R.string.res_party_size), bold = true), 16f)
			body.addRow(stepper, 8f)
			body.addRow(sms, 12f)
			message.bind(error)
			body.addRow(message, 12f)
			body.addRow(
				primary(host.str(R.string.res_waitlist_join), loading = rc.waitlistBusy) {
					// Same gate as booking: the waitlist never takes a nameless party.
					val name = rc.guestIdentity().let { it.firstName.ifBlank { it.lastName } }
					if (name.isBlank()) {
						message.bind(host.str(R.string.res_err_verify))
						return@primary
					}
					rc.joinWaitlist(name, party, sms.isChecked)
				},
				16f,
			)
			return
		}
		if (status == null) {
			// A restored entry whose first refresh is still running (or failed).
			body.addRow(ctx.bodyText(palette, host.str(R.string.app_loading), muted = true), 8f)
			message.bind(error)
			body.addRow(message, 8f)
			body.addRow(secondary(host.str(R.string.res_reload)) { rc.refreshWaitlist() }, 12f)
			return
		}
		val label = when (status.status) {
			"waiting" -> R.string.res_waitlist_waiting
			"notified" -> R.string.res_waitlist_notified
			"on_the_way" -> R.string.res_waitlist_on_the_way
			else -> R.string.res_waitlist_ended
		}
		body.addRow(ctx.bodyText(palette, host.str(label), 15f, bold = true), 8f)
		status.position?.takeIf { status.isActive }?.let {
			body.addRow(ctx.bodyText(palette, host.str(R.string.res_waitlist_position, it)), 6f)
		}
		status.quotedMin?.takeIf { status.isActive }?.let {
			body.addRow(ctx.bodyText(palette, host.str(R.string.res_waitlist_quote, it), muted = true), 4f)
		}
		message.bind(error)
		body.addRow(message, 8f)
		if (status.isActive) {
			body.addRow(secondary(host.str(R.string.res_reload)) { rc.refreshWaitlist() }, 12f)
			if (status.canOnMyWay) body.addRow(secondary(host.str(R.string.res_waitlist_on_my_way)) { rc.waitlistOnMyWay() }, 12f)
			if (status.canLeave) body.addRow(secondary(host.str(R.string.res_waitlist_leave)) { rc.leaveWaitlist() }, 12f)
		}
	}
}
