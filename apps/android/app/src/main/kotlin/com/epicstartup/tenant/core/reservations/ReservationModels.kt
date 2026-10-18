package com.epicstartup.tenant.core.reservations

import com.epicstartup.tenant.core.support.arrayOrNull
import com.epicstartup.tenant.core.support.booleanOrNull
import com.epicstartup.tenant.core.support.objectOrNull
import com.epicstartup.tenant.core.support.stringOrNull
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

// Models of the public `/reservations/...` contract (docs/reservations-contract.md).
// Every `fromJson` is exercised against the canonical fixtures in
// `src/test/resources/reservations`. Guest PII only ever lives in memory here.

internal fun <T> JSONArray?.mapObjects(transform: (JSONObject) -> T?): List<T> {
	if (this == null) return emptyList()
	return (0 until length()).mapNotNull { optJSONObject(it)?.let(transform) }
}

internal fun JSONObject.millisOrNull(name: String): Long? =
	stringOrNull(name)?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

internal fun JSONObject.intOrNull(name: String): Int? =
	if (has(name) && !isNull(name)) optInt(name) else null

data class ResSlot(
	val localMin: Int,
	val time: String,
	val serviceId: String?,
	val serviceName: String?,
	val areaId: String?,
	val areaLabel: String?,
) {
	companion object {
		fun fromJson(json: JSONObject) = ResSlot(
			localMin = json.optInt("localMin"),
			time = json.stringOrNull("time") ?: formatLocalMin(json.optInt("localMin")),
			serviceId = json.stringOrNull("serviceId"),
			serviceName = json.stringOrNull("serviceName"),
			areaId = json.stringOrNull("areaId"),
			areaLabel = json.stringOrNull("areaLabel"),
		)
	}
}

fun formatLocalMin(localMin: Int): String =
	"%02d:%02d".format((localMin / 60) % 24, localMin % 60)

data class ResAlternativeDate(val date: String, val firstLocalMin: Int)

data class ResAlternatives(
	val sameDay: List<ResSlot>,
	val otherDates: List<ResAlternativeDate>,
) {
	val isEmpty: Boolean get() = sameDay.isEmpty() && otherDates.isEmpty()

	companion object {
		val none = ResAlternatives(emptyList(), emptyList())

		fun fromJson(json: JSONObject?): ResAlternatives {
			if (json == null) return none
			return ResAlternatives(
				sameDay = json.arrayOrNull("sameDay").mapObjects { ResSlot.fromJson(it) },
				otherDates = json.arrayOrNull("otherDates").mapObjects {
					val date = it.stringOrNull("date") ?: return@mapObjects null
					ResAlternativeDate(date, it.optInt("firstLocalMin"))
				},
			)
		}
	}
}

data class ResChip(val id: String, val name: String)

data class ResLocation(
	val id: String,
	val name: String,
	val address: String?,
	val timeZone: String,
	val phone: String?,
	val partyMin: Int,
	val partyMax: Int,
	val horizonDays: Int,
	val intervalMin: Int,
	val holdMinutes: Int,
	val largePartyMode: String,
	val waitlistOnline: Boolean,
	val notifyMe: Boolean,
	val areas: List<ResChip>,
	val publicNote: String?,
) {
	companion object {
		fun fromJson(json: JSONObject): ResLocation? {
			val id = json.stringOrNull("id") ?: return null
			val party = json.objectOrNull("partySize")
			return ResLocation(
				id = id,
				name = json.stringOrNull("name") ?: id,
				address = json.objectOrNull("address")?.stringOrNull("formattedAddress"),
				timeZone = json.stringOrNull("timeZone") ?: "UTC",
				phone = json.stringOrNull("phone"),
				partyMin = party?.optInt("min", 1) ?: 1,
				partyMax = party?.optInt("max", 8) ?: 8,
				horizonDays = json.optInt("horizonDays", 60),
				intervalMin = json.optInt("intervalMin", 15),
				holdMinutes = json.optInt("holdMinutes", 5),
				largePartyMode = json.objectOrNull("largeParty")?.stringOrNull("mode") ?: "contact",
				waitlistOnline = json.objectOrNull("waitlist")?.booleanOrNull("online") ?: false,
				notifyMe = json.booleanOrNull("notifyMe") ?: false,
				areas = json.arrayOrNull("areas").mapObjects(::chip),
				publicNote = json.stringOrNull("publicNote"),
			)
		}
	}
}

private fun chip(json: JSONObject): ResChip? {
	val id = json.stringOrNull("id") ?: return null
	return ResChip(id, json.stringOrNull("name") ?: id)
}

data class ResConfig(
	val organizationName: String,
	val locations: List<ResLocation>,
	val occasions: List<ResChip>,
	val dietary: List<ResChip>,
	val nowMs: Long?,
) {
	companion object {
		fun fromJson(json: JSONObject) = ResConfig(
			organizationName = json.objectOrNull("organization")?.stringOrNull("name") ?: "",
			locations = json.arrayOrNull("locations").mapObjects { ResLocation.fromJson(it) },
			occasions = json.arrayOrNull("occasions").mapObjects(::chip),
			dietary = json.arrayOrNull("dietary").mapObjects(::chip),
			nowMs = json.millisOrNull("now"),
		)
	}
}

data class ResAvailability(
	val status: String,
	val date: String,
	val partySize: Int,
	val slots: List<ResSlot>,
	val alternatives: ResAlternatives,
	val waitlist: Boolean,
	val notifyMe: Boolean,
	val largePartyPhone: String?,
	val nowMs: Long?,
) {
	companion object {
		fun fromJson(json: JSONObject) = ResAvailability(
			status = json.stringOrNull("status") ?: "available",
			date = json.stringOrNull("date") ?: "",
			partySize = json.optInt("partySize"),
			slots = json.arrayOrNull("slots").mapObjects { ResSlot.fromJson(it) },
			alternatives = ResAlternatives.fromJson(json.objectOrNull("alternatives")),
			waitlist = json.booleanOrNull("waitlist") ?: false,
			notifyMe = json.booleanOrNull("notifyMe") ?: false,
			largePartyPhone = json.objectOrNull("largeParty")?.stringOrNull("phone"),
			nowMs = json.millisOrNull("now"),
		)
	}
}

data class ResCalendarDay(
	val date: String,
	val hasAvailability: Boolean,
	val status: String,
	val slotCount: Int,
) {
	companion object {
		fun fromJson(json: JSONObject): ResCalendarDay? {
			val date = json.stringOrNull("date") ?: return null
			return ResCalendarDay(
				date = date,
				hasAvailability = json.booleanOrNull("hasAvailability") ?: false,
				status = json.stringOrNull("status") ?: "available",
				slotCount = json.optInt("slotCount"),
			)
		}
	}
}

data class ResCalendar(val days: List<ResCalendarDay>, val nowMs: Long?) {
	companion object {
		fun fromJson(json: JSONObject) = ResCalendar(
			days = json.arrayOrNull("days").mapObjects { ResCalendarDay.fromJson(it) },
			nowMs = json.millisOrNull("now"),
		)
	}
}

data class ResPolicy(
	val kind: String,
	val purpose: String,
	val termsVersion: Int,
	val terms: String?,
	val amountMinor: Int,
	val totalAmountMinor: Int,
	val currency: String,
	val freeCancelUntilMin: Int,
) {
	companion object {
		fun fromJson(json: JSONObject?): ResPolicy? {
			if (json == null) return null
			return ResPolicy(
				kind = json.stringOrNull("kind") ?: "deposit",
				purpose = json.stringOrNull("purpose") ?: "deposit",
				termsVersion = json.optInt("termsVersion"),
				terms = json.stringOrNull("terms"),
				amountMinor = json.optInt("amountMinor"),
				totalAmountMinor = json.optInt("totalAmountMinor"),
				currency = json.stringOrNull("currency") ?: "USD",
				freeCancelUntilMin = json.optInt("freeCancelUntilMin"),
			)
		}
	}
}

data class ResHold(
	val holdToken: String,
	val expiresAtMs: Long,
	val serverNowMs: Long,
	val locationId: String,
	val date: String,
	val localMin: Int,
	val partySize: Int,
	val serviceId: String?,
	val requiresPayment: Boolean,
	val policy: ResPolicy?,
) {
	companion object {
		fun fromJson(json: JSONObject): ResHold? {
			val token = json.stringOrNull("holdToken") ?: return null
			val slot = json.objectOrNull("slot") ?: return null
			return ResHold(
				holdToken = token,
				expiresAtMs = json.millisOrNull("expiresAt") ?: return null,
				serverNowMs = json.millisOrNull("now") ?: return null,
				locationId = json.stringOrNull("locationId") ?: "",
				date = slot.stringOrNull("date") ?: "",
				localMin = slot.optInt("localMin"),
				partySize = slot.optInt("partySize"),
				serviceId = slot.stringOrNull("serviceId"),
				requiresPayment = json.booleanOrNull("requiresPayment") ?: false,
				policy = ResPolicy.fromJson(json.objectOrNull("policy")),
			)
		}
	}
}

data class ResSummary(
	val id: String,
	val confirmationCode: String,
	val status: String,
	val locationId: String,
	val locationName: String?,
	val date: String,
	val localMin: Int,
	val time: String,
	val startAtMs: Long,
	val endAtMs: Long,
	val partySize: Int,
	val timeZone: String,
) {
	companion object {
		fun fromJson(json: JSONObject): ResSummary? {
			val id = json.stringOrNull("id") ?: return null
			return ResSummary(
				id = id,
				confirmationCode = json.stringOrNull("confirmationCode") ?: "",
				status = json.stringOrNull("status") ?: "booked",
				locationId = json.stringOrNull("locationId") ?: "",
				locationName = json.stringOrNull("locationName"),
				date = json.stringOrNull("date") ?: "",
				localMin = json.optInt("localMin"),
				time = json.stringOrNull("time") ?: "",
				startAtMs = json.millisOrNull("startAt") ?: 0L,
				endAtMs = json.millisOrNull("endAt") ?: 0L,
				partySize = json.optInt("partySize"),
				timeZone = json.stringOrNull("timeZone") ?: "UTC",
			)
		}
	}
}

data class ResPaymentBlock(
	val paymentToken: String,
	val purpose: String,
	val amountMinor: Int,
	val currency: String,
	val expiresAtMs: Long?,
	val payUrl: String,
) {
	companion object {
		fun fromJson(json: JSONObject?): ResPaymentBlock? {
			if (json == null) return null
			return ResPaymentBlock(
				paymentToken = json.stringOrNull("paymentToken") ?: return null,
				purpose = json.stringOrNull("purpose") ?: "deposit",
				amountMinor = json.optInt("amountMinor"),
				currency = json.stringOrNull("currency") ?: "USD",
				expiresAtMs = json.millisOrNull("expiresAt"),
				payUrl = json.stringOrNull("payUrl") ?: return null,
			)
		}
	}
}

/** `POST /reservations` and `POST /reservations/requests`. */
data class ResBooking(
	val reservation: ResSummary,
	val paymentStatus: String,
	val paymentExpiresAtMs: Long?,
	val manageToken: String,
	val payment: ResPaymentBlock?,
) {
	companion object {
		fun fromJson(json: JSONObject): ResBooking? {
			val reservation = json.objectOrNull("reservation") ?: return null
			return ResBooking(
				reservation = ResSummary.fromJson(reservation) ?: return null,
				paymentStatus = reservation.stringOrNull("paymentStatus") ?: "none",
				paymentExpiresAtMs = reservation.millisOrNull("paymentExpiresAt"),
				manageToken = json.stringOrNull("manageToken") ?: return null,
				payment = ResPaymentBlock.fromJson(json.objectOrNull("payment")),
			)
		}
	}
}

data class ResManageView(
	val nowMs: Long?,
	val reservation: ResSummary,
	val firstName: String?,
	val runningLateMin: Int?,
	val locationAddress: String?,
	val locationPhone: String?,
	val maskedPhone: String?,
	val maskedEmail: String?,
	val paymentStatus: String,
	val canModify: Boolean,
	val canCancel: Boolean,
	val cancelDeadlineMs: Long?,
) {
	/** Running late is a client-side convenience; the server stays authoritative. */
	fun canRunLate(deviceNowMs: Long): Boolean =
		(reservation.status == "booked" || reservation.status == "confirmed") &&
			deviceNowMs < reservation.endAtMs

	companion object {
		fun fromJson(json: JSONObject): ResManageView? {
			val reservation = json.objectOrNull("reservation") ?: return null
			val location = reservation.objectOrNull("location")
			val contact = json.objectOrNull("contact")
			return ResManageView(
				nowMs = json.millisOrNull("now"),
				reservation = ResSummary.fromJson(reservation) ?: return null,
				firstName = json.stringOrNull("firstName"),
				runningLateMin = reservation.intOrNull("runningLateMin"),
				locationAddress = location?.stringOrNull("address"),
				locationPhone = location?.stringOrNull("phone"),
				maskedPhone = contact?.stringOrNull("phone"),
				maskedEmail = contact?.stringOrNull("email"),
				paymentStatus = json.stringOrNull("paymentStatus") ?: "none",
				canModify = json.booleanOrNull("canModify") ?: false,
				canCancel = json.booleanOrNull("canCancel") ?: false,
				cancelDeadlineMs = json.millisOrNull("cancelDeadline"),
			)
		}
	}
}

/** `GET /manage/payment`: exactly these three fields. */
data class ResPaymentStatus(
	val paymentStatus: String,
	val reservationStatus: String,
	val nowMs: Long?,
) {
	companion object {
		fun fromJson(json: JSONObject) = ResPaymentStatus(
			paymentStatus = json.stringOrNull("paymentStatus") ?: "none",
			reservationStatus = json.stringOrNull("reservationStatus") ?: "",
			nowMs = json.millisOrNull("now"),
		)
	}
}

data class ResMineItem(val summary: ResSummary, val manageToken: String)

data class ResMine(val upcoming: List<ResMineItem>, val past: List<ResMineItem>) {
	companion object {
		private fun items(array: JSONArray?) = array.mapObjects { json ->
			val summary = ResSummary.fromJson(json) ?: return@mapObjects null
			ResMineItem(summary, json.stringOrNull("manageToken") ?: return@mapObjects null)
		}

		fun fromJson(json: JSONObject) = ResMine(
			upcoming = items(json.arrayOrNull("upcoming")),
			past = items(json.arrayOrNull("past")),
		)
	}
}

data class ResWaitlistJoin(
	val entryId: String,
	val locationId: String,
	val status: String,
	val position: Int?,
	val partySize: Int,
	val quotedMin: Int?,
	val statusToken: String,
) {
	companion object {
		fun fromJson(json: JSONObject): ResWaitlistJoin? {
			val entry = json.objectOrNull("entry") ?: return null
			return ResWaitlistJoin(
				entryId = entry.stringOrNull("id") ?: return null,
				locationId = entry.stringOrNull("locationId") ?: "",
				status = entry.stringOrNull("status") ?: "waiting",
				position = entry.intOrNull("position"),
				partySize = entry.optInt("partySize"),
				quotedMin = entry.intOrNull("quotedMin"),
				statusToken = json.stringOrNull("statusToken") ?: return null,
			)
		}
	}
}

data class ResWaitlistStatus(
	val status: String,
	val position: Int?,
	val partySize: Int,
	val quotedMin: Int?,
	val canLeave: Boolean,
	val canOnMyWay: Boolean,
) {
	val isActive: Boolean get() = status in ACTIVE

	companion object {
		private val ACTIVE = setOf("waiting", "notified", "on_the_way")

		fun fromJson(json: JSONObject) = ResWaitlistStatus(
			status = json.stringOrNull("status") ?: "waiting",
			position = json.intOrNull("position"),
			partySize = json.optInt("partySize"),
			quotedMin = json.intOrNull("quotedMin"),
			canLeave = json.booleanOrNull("canLeave") ?: false,
			canOnMyWay = json.booleanOrNull("canOnMyWay") ?: false,
		)
	}
}
