package com.epicstartup.tenant.core.reservations

import com.epicstartup.tenant.core.config.TenantConfiguration
import com.epicstartup.tenant.core.net.ApiException
import com.epicstartup.tenant.core.net.ApiRequest
import com.epicstartup.tenant.core.net.HttpTransport
import com.epicstartup.tenant.core.net.HttpUrlConnectionTransport
import com.epicstartup.tenant.core.session.CustomerSession
import com.epicstartup.tenant.core.support.objectOrNull
import com.epicstartup.tenant.core.support.parseJsonObject
import com.epicstartup.tenant.core.support.stringOrNull
import java.net.URLEncoder
import java.util.UUID
import org.json.JSONObject

/**
 * A non-2xx answer from `/reservations/...`: the stable `error` code (also the
 * exception message), the optional `reason` of a 429, and the alternatives of a
 * 409 `slot_unavailable`. Never carries a rejected value, so it is safe to show.
 */
class ReservationsException(
	statusCode: Int,
	val code: String,
	val reason: String? = null,
	val alternatives: ResAlternatives = ResAlternatives.none,
) : ApiException(statusCode, code)

/** What the signed-in customer typed (or the profile supplied) for one booking. */
data class ResGuest(
	val firstName: String,
	val lastName: String,
	val phone: String,
	val email: String?,
)

data class ResBookingDetails(
	val guest: ResGuest,
	val locale: String,
	val requests: String? = null,
	val occasionTagId: String? = null,
	val dietary: String? = null,
	val areaId: String? = null,
	val smsOptIn: Boolean = false,
	val policyTermsVersion: Int? = null,
)

/**
 * The reservations half of the tenant-api contract, as the native apps use it.
 *
 * - Every call carries the site `Origin` (https builds) and the `slug`/`host`
 *   binding query, plus `X-Client: android` (server channel `native`).
 * - Holds, bookings, requests, waitlist joins and `/mine` run through
 *   [CustomerSession.authorized]: the verified customer token replaces
 *   Turnstile. Manage and waitlist-status calls carry only the capability in
 *   `X-Reservation-Token`.
 * - Mutations are POST only (`HttpURLConnection` cannot send PATCH).
 * - Tokens never enter a URL and are never logged.
 */
class ReservationsClient(
	private val configuration: TenantConfiguration,
	private val session: CustomerSession,
	private val transport: HttpTransport = HttpUrlConnectionTransport(),
) {
	// MARK: - Discovery

	fun config(locale: String?): ResConfig =
		ResConfig.fromJson(get("/config", localeQuery(locale)))

	fun availability(
		locationId: String,
		date: String,
		partySize: Int,
		localMin: Int? = null,
		locale: String? = null,
	): ResAvailability {
		val query = mutableListOf("locationId" to locationId, "date" to date, "partySize" to "$partySize")
		if (localMin != null) query += "localMin" to "$localMin"
		return ResAvailability.fromJson(get("/availability", query + localeQuery(locale)))
	}

	fun calendar(locationId: String, partySize: Int, from: String, to: String): ResCalendar =
		ResCalendar.fromJson(
			get(
				"/calendar",
				listOf("locationId" to locationId, "partySize" to "$partySize", "from" to from, "to" to to),
			),
		)

	// MARK: - Holds and bookings (customer token)

	fun createHold(
		locationId: String,
		date: String,
		localMin: Int,
		partySize: Int,
		serviceId: String? = null,
		areaId: String? = null,
		replaceHoldToken: String? = null,
	): ResHold {
		val body = JSONObject().apply {
			put("locationId", locationId)
			put(
				"slot",
				JSONObject().apply {
					put("date", date)
					put("localMin", localMin)
					put("partySize", partySize)
					if (serviceId != null) put("serviceId", serviceId)
				},
			)
			if (areaId != null) put("areaPref", areaId)
			if (replaceHoldToken != null) put("replaceHoldToken", replaceHoldToken)
		}
		return ResHold.fromJson(authorizedPost("/holds", body)) ?: throw unexpected()
	}

	fun releaseHold(holdToken: String) {
		runCatching { post("/holds/release", JSONObject().put("holdToken", holdToken)) }
	}

	/** [idempotencyKey] is chosen by the caller so a retry after a network error reuses it. */
	fun book(holdToken: String, details: ResBookingDetails, idempotencyKey: String): ResBooking {
		val body = detailsJson(details).put("holdToken", holdToken)
		return ResBooking.fromJson(authorizedPost("/", body, idempotencyKey)) ?: throw unexpected()
	}

	fun requestLargeParty(
		locationId: String,
		date: String,
		localMin: Int,
		partySize: Int,
		details: ResBookingDetails,
		idempotencyKey: String,
	): ResBooking {
		val body = detailsJson(details).apply {
			put("locationId", locationId)
			put(
				"slot",
				JSONObject().put("date", date).put("localMin", localMin).put("partySize", partySize),
			)
		}
		return ResBooking.fromJson(authorizedPost("/requests", body, idempotencyKey)) ?: throw unexpected()
	}

	fun mine(): ResMine = ResMine.fromJson(authorizedGet("/mine"))

	// MARK: - Manage (capability token)

	fun manage(token: String): ResManageView =
		ResManageView.fromJson(get("/manage", emptyList(), token)) ?: throw unexpected()

	fun manageAvailability(token: String, date: String, partySize: Int): ResAvailability =
		ResAvailability.fromJson(
			get("/manage/availability", listOf("date" to date, "partySize" to "$partySize"), token),
		)

	fun modify(token: String, date: String, localMin: Int, partySize: Int): ResManageView =
		ResManageView.fromJson(
			post(
				"/manage/modify",
				JSONObject().put("date", date).put("localMin", localMin).put("partySize", partySize),
				token = token,
			),
		) ?: throw unexpected()

	fun cancel(token: String): ResManageView =
		ResManageView.fromJson(post("/manage/cancel", JSONObject(), token = token)) ?: throw unexpected()

	fun confirm(token: String): ResManageView =
		ResManageView.fromJson(post("/manage/confirm", JSONObject(), token = token)) ?: throw unexpected()

	fun runningLate(token: String, minutes: Int): ResManageView =
		ResManageView.fromJson(
			post("/manage/running-late", JSONObject().put("minutes", minutes), token = token),
		) ?: throw unexpected()

	/** Accepts the manage token or the payment token of the booking. */
	fun paymentStatus(token: String): ResPaymentStatus =
		ResPaymentStatus.fromJson(get("/manage/payment", emptyList(), token))

	// MARK: - Waitlist

	fun joinWaitlist(
		locationId: String,
		name: String,
		partySize: Int,
		phone: String,
		smsOptIn: Boolean,
		locale: String,
		idempotencyKey: String,
	): ResWaitlistJoin {
		val body = JSONObject().apply {
			put("locationId", locationId)
			put("name", name)
			put("partySize", partySize)
			put("phone", phone)
			put("smsOptIn", smsOptIn)
			put("locale", locale)
		}
		return ResWaitlistJoin.fromJson(authorizedPost("/waitlist/join", body, idempotencyKey))
			?: throw unexpected()
	}

	fun waitlistStatus(token: String): ResWaitlistStatus =
		ResWaitlistStatus.fromJson(get("/waitlist/status", emptyList(), token))

	fun leaveWaitlist(token: String): ResWaitlistStatus =
		ResWaitlistStatus.fromJson(post("/waitlist/status/leave", JSONObject(), token = token))

	fun waitlistOnMyWay(token: String): ResWaitlistStatus =
		ResWaitlistStatus.fromJson(post("/waitlist/status/on-my-way", JSONObject(), token = token))

	// MARK: - Plumbing

	private fun detailsJson(details: ResBookingDetails): JSONObject = JSONObject().apply {
		put(
			"guest",
			JSONObject().apply {
				put("firstName", details.guest.firstName)
				put("lastName", details.guest.lastName)
				put("phone", details.guest.phone)
				if (!details.guest.email.isNullOrBlank()) put("email", details.guest.email)
			},
		)
		put("locale", details.locale)
		put("smsOptIn", details.smsOptIn)
		if (!details.requests.isNullOrBlank()) put("requests", details.requests)
		if (details.occasionTagId != null) put("occasionTagId", details.occasionTagId)
		if (!details.dietary.isNullOrBlank()) put("dietary", details.dietary)
		if (details.areaId != null) put("areaPref", details.areaId)
		if (details.policyTermsVersion != null) {
			put("policyAccepted", JSONObject().put("termsVersion", details.policyTermsVersion.toString()))
		}
		// The honeypot stays empty; the verified token replaces Turnstile.
		put("website", "")
	}

	private fun localeQuery(locale: String?): List<Pair<String, String>> =
		if (locale.isNullOrBlank()) emptyList() else listOf("locale" to locale)

	private fun get(
		path: String,
		query: List<Pair<String, String>>,
		token: String? = null,
	): JSONObject = parse(perform(build("GET", path, query, null, token, null, null)))

	private fun post(
		path: String,
		body: JSONObject,
		idempotencyKey: String? = null,
		token: String? = null,
	): JSONObject = parse(perform(build("POST", path, emptyList(), body, token, idempotencyKey, null)))

	private fun authorizedGet(path: String): JSONObject =
		parse(session.authorized { bearer -> perform(build("GET", path, emptyList(), null, null, null, bearer)) })

	private fun authorizedPost(path: String, body: JSONObject, idempotencyKey: String? = null): JSONObject =
		parse(
			session.authorized { bearer ->
				perform(build("POST", path, emptyList(), body, null, idempotencyKey, bearer))
			},
		)

	internal fun build(
		method: String,
		path: String,
		query: List<Pair<String, String>>,
		body: JSONObject?,
		token: String?,
		idempotencyKey: String?,
		bearer: String?,
	): ApiRequest {
		val items = configuration.siteAddress.queryItems + query
		val url = buildString {
			append(configuration.tenantApiBaseUrl.trimEnd('/'))
			append("/reservations")
			if (path != "/") append(path)
			if (items.isNotEmpty()) {
				append('?')
				append(items.joinToString("&") { (name, value) -> "${enc(name)}=${enc(value)}" })
			}
		}
		val headers = mutableMapOf("Accept" to "application/json", "X-Client" to CLIENT)
		configuration.siteAddress.authOriginHeader?.let { headers["Origin"] = it }
		if (body != null) headers["Content-Type"] = "application/json"
		if (token != null) headers["X-Reservation-Token"] = token
		if (idempotencyKey != null) headers["Idempotency-Key"] = idempotencyKey
		if (bearer != null) headers["Authorization"] = "Bearer $bearer"
		return ApiRequest(
			url = url,
			method = method,
			headers = headers,
			body = body?.toString()?.toByteArray(Charsets.UTF_8),
			timeoutMs = configuration.requestTimeoutMs,
		)
	}

	private fun perform(request: ApiRequest): ByteArray {
		val response = try {
			transport.send(request)
		} catch (error: ApiException) {
			throw error
		} catch (error: Exception) {
			// The message of a transport error can contain the URL; keep it generic.
			throw ApiException(0, "Network error")
		}
		if (response.statusCode !in 200..299) throw errorFrom(response.statusCode, response.body)
		return response.body
	}

	private fun errorFrom(status: Int, body: ByteArray): ApiException {
		val json = parseJsonObject(body) ?: return ApiException.from(status, body)
		val code = json.stringOrNull("error") ?: return ApiException.from(status, body)
		return ReservationsException(
			statusCode = status,
			code = code,
			reason = json.stringOrNull("reason"),
			alternatives = ResAlternatives.fromJson(json.objectOrNull("alternatives")),
		)
	}

	private fun parse(body: ByteArray): JSONObject = parseJsonObject(body) ?: throw unexpected()

	private fun unexpected() = ApiException(200, "Unexpected response from the server")

	private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")

	companion object {
		const val CLIENT = "android"

		/** A fresh key for one booking attempt; the flow reuses it for retries. */
		fun newIdempotencyKey(): String = "and-" + UUID.randomUUID().toString()
	}
}
