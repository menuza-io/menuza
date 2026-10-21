package com.epicstartup.tenant.ui.reservations

import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.reservations.FlowError
import java.text.NumberFormat
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Currency
import java.util.Locale

/** Locale-aware display helpers. Dates and times are business-local, never device-zone converted. */
internal object ResFormat {
	fun date(date: String, languageTag: String): String = runCatching {
		LocalDate.parse(date).format(
			DateTimeFormatter.ofPattern("EEE d MMM", Locale.forLanguageTag(languageTag)),
		)
	}.getOrDefault(date)

	fun dayNumber(date: String, languageTag: String): String = runCatching {
		LocalDate.parse(date).format(
			DateTimeFormatter.ofPattern("EEE\nd", Locale.forLanguageTag(languageTag)),
		)
	}.getOrDefault(date)

	fun time(localMin: Int, languageTag: String): String = runCatching {
		LocalTime.of((localMin / 60) % 24, localMin % 60).format(
			DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.forLanguageTag(languageTag)),
		)
	}.getOrDefault("%02d:%02d".format((localMin / 60) % 24, localMin % 60))

	fun money(minor: Int, currency: String, languageTag: String): String = runCatching {
		val code = Currency.getInstance(currency)
		val digits = code.defaultFractionDigits.coerceAtLeast(0)
		val format = NumberFormat.getCurrencyInstance(Locale.forLanguageTag(languageTag))
		format.currency = code
		format.format(minor / Math.pow(10.0, digits.toDouble()))
	}.getOrDefault("$minor $currency")

	fun countdown(ms: Long): String {
		val total = (ms.coerceAtLeast(0) + 999) / 1000
		return "%d:%02d".format(total / 60, total % 60)
	}

	fun statusRes(status: String): Int = when (status) {
		"booked" -> R.string.res_status_booked
		"confirmed" -> R.string.res_status_confirmed
		"requested" -> R.string.res_status_requested
		"pending_payment" -> R.string.res_status_pending_payment
		"cancelled", "declined" -> R.string.res_status_cancelled
		"arrived", "partially_arrived", "seated", "partially_seated" -> R.string.res_status_seated
		"finished" -> R.string.res_status_finished
		"no_show" -> R.string.res_status_no_show
		else -> R.string.res_status_expired
	}

	fun errorRes(error: FlowError): Int = when (error) {
		is FlowError.SlotUnavailable -> R.string.res_err_slot
		FlowError.HoldExpired -> R.string.res_err_expired
		FlowError.PolicyRequired -> R.string.res_err_policy
		is FlowError.RateLimited ->
			if (error.reason == "phone_active_limit") R.string.res_err_rate_phone else R.string.res_err_rate
		FlowError.VerificationFailed -> R.string.res_err_verify
		FlowError.PhoneOverlap -> R.string.res_err_overlap
		FlowError.NotFound -> R.string.res_err_not_found
		FlowError.Invalid -> R.string.res_err_invalid
		FlowError.Network -> R.string.res_err_network
		is FlowError.Other -> R.string.res_err_other
	}
}
