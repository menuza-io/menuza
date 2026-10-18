package com.epicstartup.tenant.core.reservations

import com.epicstartup.tenant.core.StubTransport
import com.epicstartup.tenant.core.jsonResponse
import com.epicstartup.tenant.core.makeAccessToken
import com.epicstartup.tenant.core.makeConfiguration
import com.epicstartup.tenant.core.model.AuthTokens
import com.epicstartup.tenant.core.net.ApiException
import com.epicstartup.tenant.core.net.ApiRequest
import com.epicstartup.tenant.core.requestBodyJson
import com.epicstartup.tenant.core.net.TenantApiClient
import com.epicstartup.tenant.core.session.CustomerSession
import com.epicstartup.tenant.core.session.InMemoryTokenStorage
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReservationsClientTests {
	private val access = makeAccessToken()

	private fun client(
		origin: String? = "https://acme.epic-startup.com",
		handler: (ApiRequest) -> com.epicstartup.tenant.core.net.ApiResponse,
	): Pair<ReservationsClient, StubTransport> {
		val transport = StubTransport(handler)
		val configuration = makeConfiguration(origin = origin)
		val session = CustomerSession(
			TenantApiClient(configuration, transport),
			InMemoryTokenStorage(AuthTokens(accessToken = access, refreshToken = "refresh")),
		)
		return ReservationsClient(configuration, session, transport) to transport
	}

	private fun fixture(name: String) = jsonResponse(200, ReservationFixtures.text(name))

	private val guest = ResGuest("Jane", "Doe", "+14155550123", "jane@example.com")
	private val details = ResBookingDetails(guest = guest, locale = "en", smsOptIn = true)

	@Test
	fun everyCallCarriesOriginBindingAndClientHeader() {
		val (client, transport) = client { request ->
			when {
				request.url.contains("/config") -> fixture("config")
				request.url.contains("/availability") -> fixture("availability")
				request.url.contains("/mine") -> fixture("mine")
				request.url.contains("/holds") -> jsonResponse(201, ReservationFixtures.text("hold"))
				else -> fixture("manage")
			}
		}
		client.config("en")
		client.availability("loc_pub_main", "2030-06-24", 2)
		client.mine()
		client.createHold("loc_pub_main", "2030-06-24", 1140, 2)
		client.manage("rsv_m_token")

		assertEquals(5, transport.requests.size)
		transport.requests.forEach { request ->
			assertEquals("android", request.headers["X-Client"], request.url)
			assertEquals("https://acme.epic-startup.com", request.headers["Origin"], request.url)
			assertTrue(request.url.contains("slug=acme"), request.url)
			assertTrue(request.url.startsWith("https://tenant-us.epic-startup.com/reservations"), request.url)
		}
	}

	@Test
	fun localBuildsBindBySlugWithoutOrigin() {
		val (client, transport) = client(origin = "http://acme.epic-startup.test:3008") { fixture("config") }
		client.config(null)
		val request = transport.lastRequest!!
		assertNull(request.headers["Origin"])
		assertTrue(request.url.contains("slug=acme"))
	}

	@Test
	fun customerTokenReplacesTurnstileOnHoldsBookingsRequestsAndWaitlist() {
		val (client, transport) = client { request ->
			when {
				request.url.contains("/holds") -> jsonResponse(201, ReservationFixtures.text("hold"))
				request.url.contains("/requests") -> jsonResponse(201, ReservationFixtures.text("request"))
				request.url.contains("/waitlist/join") -> jsonResponse(201, ReservationFixtures.text("waitlist-join"))
				else -> jsonResponse(201, ReservationFixtures.text("booking"))
			}
		}
		client.createHold("loc_pub_main", "2030-06-24", 1140, 2)
		client.book("hold_token_value", details, "key-0001-aaaa")
		client.requestLargeParty("loc_pub_main", "2030-06-24", 1020, 8, details, "key-0002-bbbb")
		client.joinWaitlist("loc_pub_main", "Jane", 2, "+14155550123", false, "en", "key-0003-cccc")

		transport.requests.forEach { request ->
			assertEquals("Bearer $access", request.headers["Authorization"], request.url)
			assertFalse(request.headers.containsKey("X-Turnstile-Token"))
			assertFalse(String(request.body!!).contains("turnstile", ignoreCase = true))
			assertEquals("POST", request.method)
		}
	}

	@Test
	fun bookingBodyHasTheGuestFromTheProfileAndAnEmptyHoneypot() {
		val (client, transport) = client { jsonResponse(201, ReservationFixtures.text("booking")) }
		client.book("hold_token_value", details.copy(policyTermsVersion = 2), "key-0001-aaaa")
		val body = requestBodyJson(transport.lastRequest!!)
		assertEquals("hold_token_value", body.getString("holdToken"))
		assertEquals("+14155550123", body.getJSONObject("guest").getString("phone"))
		assertEquals("", body.getString("website"))
		assertEquals("2", body.getJSONObject("policyAccepted").getString("termsVersion"))
		assertEquals("key-0001-aaaa", transport.lastRequest!!.headers["Idempotency-Key"])
	}

	@Test
	fun manageAndWaitlistUseTheCapabilityHeaderNeverTheUrlOrBearer() {
		val (client, transport) = client { request ->
			when {
				request.url.contains("/waitlist") -> fixture("waitlist-status")
				request.url.contains("/payment") -> fixture("payment-status-pending")
				else -> fixture("manage")
			}
		}
		client.manage("rsv_m_secret")
		client.modify("rsv_m_secret", "2030-06-24", 1170, 2)
		client.cancel("rsv_m_secret")
		client.runningLate("rsv_m_secret", 10)
		client.paymentStatus("rsv_m_secret")
		client.waitlistStatus("rsv_w_secret")
		client.leaveWaitlist("rsv_w_secret")
		client.waitlistOnMyWay("rsv_w_secret")

		transport.requests.forEach { request ->
			assertTrue(request.headers["X-Reservation-Token"]!!.endsWith("secret"), request.url)
			assertFalse(request.url.contains("secret"), "token leaked into ${request.url}")
			assertFalse(request.headers.containsKey("Authorization"))
		}
		assertEquals("GET", transport.requests.first().method)
	}

	@Test
	fun mutationsArePostOnlyNeverPatch() {
		val (client, transport) = client { fixture("manage") }
		client.modify("t", "2030-06-24", 1170, 2)
		client.cancel("t")
		client.confirm("t")
		client.runningLate("t", 5)
		assertTrue(transport.requests.all { it.method == "POST" })
		assertTrue(transport.requests.none { it.method == "PATCH" || it.method == "PUT" || it.method == "DELETE" })
		assertEquals("/reservations/manage/running-late", java.net.URI(transport.requests.last().url).path)

		val sources = listOf("src/main/kotlin/com/epicstartup/tenant/core/net", "src/main/kotlin/com/epicstartup/tenant/core/reservations")
		sources.map(::File).filter { it.exists() }.flatMap { it.walkTopDown().filter { f -> f.isFile } }.forEach {
			assertFalse(it.readText().contains("\"PATCH\""), "PATCH in ${it.name}")
		}
	}

	@Test
	fun theSameIdempotencyKeyIsSentOnRetryAfterANetworkError() {
		var failures = 1
		val (client, transport) = client { request ->
			if (failures-- > 0) throw java.io.IOException("offline")
			jsonResponse(201, ReservationFixtures.text("booking"))
		}
		val flow = BookingFlow()
		val selection = ResSelection("loc_pub_main", "2030-06-24", 2)
		flow.holdAcquired(selection, ResHold.fromJson(ReservationFixtures.json("hold"))!!, 0)
		flow.beginDetails()
		flow.review(details)

		val first = flow.beginSubmit { ReservationsClient.newIdempotencyKey() }!!
		val error = assertFailsWith<ApiException> { client.book("hold_token_value", details, first) }
		assertTrue(error.isTransportFailure)
		assertFalse(error.message.contains("offline"))
		flow.bookingFailed(error)

		val second = flow.beginSubmit { ReservationsClient.newIdempotencyKey() }!!
		assertEquals(first, second)
		client.book("hold_token_value", details, second)
		assertEquals(listOf(first, first), transport.requests.map { it.headers["Idempotency-Key"] })
	}

	@Test
	fun newAttemptsGetNewKeys() {
		assertNotEquals(ReservationsClient.newIdempotencyKey(), ReservationsClient.newIdempotencyKey())
		assertTrue(Regex("^[A-Za-z0-9._:-]{8,128}$").matches(ReservationsClient.newIdempotencyKey()))
	}

	@Test
	fun errorBodiesBecomeTypedExceptionsWithAlternativesAndReason() {
		val (client, _) = client { jsonResponse(409, ReservationFixtures.text("error-slot-unavailable")) }
		val slot = assertFailsWith<ReservationsException> { client.createHold("loc", "2030-06-24", 1140, 2) }
		assertEquals(409, slot.statusCode)
		assertEquals("slot_unavailable", slot.code)
		assertFalse(slot.alternatives.isEmpty)

		val (limited, _) = client { jsonResponse(429, ReservationFixtures.text("error-rate-limited")) }
		val rate = assertFailsWith<ReservationsException> { limited.book("hold_token_value", details, "key-0001-aaaa") }
		assertEquals("phone_active_limit", rate.reason)
	}

	@Test
	fun anExpiredAccessTokenRefreshesOnceThenRetries() {
		var calls = 0
		val (client, transport) = client { request ->
			when {
				request.url.contains("/auth/refresh") ->
					jsonResponse(200, """{"accessToken":"${makeAccessToken(name = "New")}","refreshToken":"r2"}""")
				else -> if (calls++ == 0) jsonResponse(401, """{"error":"unauthorized"}""") else fixture("mine")
			}
		}
		client.mine()
		assertEquals(3, transport.requests.size)
		assertTrue(transport.requests[2].headers["Authorization"]!!.startsWith("Bearer "))
		assertNotEquals(transport.requests[0].headers["Authorization"], transport.requests[2].headers["Authorization"])
	}

	@Test
	fun noGuestDetailsOrTokensAppearInSourceLogging() {
		val root = File("src/main/kotlin/com/epicstartup/tenant")
		if (!root.exists()) return
		val logging = Regex("""\b(Log\.[a-z]\(|println\(|printStackTrace)""")
		listOf("core/reservations", "ui/reservations", "platform/KeystoreReservationTokenStorage.kt")
			.map { File(root, it) }
			.flatMap { if (it.isDirectory) it.walkTopDown().filter { f -> f.isFile }.toList() else listOf(it) }
			.forEach { assertFalse(logging.containsMatchIn(it.readText()), "logging in ${it.name}") }
	}
}
