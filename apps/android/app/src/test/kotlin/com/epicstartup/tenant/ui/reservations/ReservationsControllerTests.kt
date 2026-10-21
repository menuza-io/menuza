package com.epicstartup.tenant.ui.reservations

import com.epicstartup.tenant.core.StubTransport
import com.epicstartup.tenant.core.jsonResponse
import com.epicstartup.tenant.core.makeAccessToken
import com.epicstartup.tenant.core.makeConfiguration
import com.epicstartup.tenant.core.model.AuthTokens
import com.epicstartup.tenant.core.model.CustomerProfile
import com.epicstartup.tenant.core.net.ApiRequest
import com.epicstartup.tenant.core.net.ApiResponse
import com.epicstartup.tenant.core.net.TenantApiClient
import com.epicstartup.tenant.core.reservations.InMemoryReservationTokenStorage
import com.epicstartup.tenant.core.reservations.ReservationFixtures
import com.epicstartup.tenant.core.reservations.ReservationTokenKeys
import com.epicstartup.tenant.core.reservations.ReservationsClient
import com.epicstartup.tenant.core.reservations.ResLocation
import com.epicstartup.tenant.core.session.CustomerSession
import com.epicstartup.tenant.core.session.InMemoryTokenStorage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Runs every task inline, in order, on the calling thread. */
private class InlineTasks : ReservationTasks {
	/** When set, callbacks wait until [flush] (an answer "still in flight"). */
	var deferred = false
	private val pending = mutableListOf<() -> Unit>()

	override fun <T> run(work: () -> T, onSuccess: (T) -> Unit, onFailure: (Exception) -> Unit) {
		val outcome = try {
			Result.success(work())
		} catch (error: Exception) {
			Result.failure(error)
		}
		val deliver = {
			outcome.fold(onSuccess) { onFailure(it as Exception) }
		}
		if (deferred) pending += deliver else deliver()
	}

	fun flush() {
		deferred = false
		pending.toList().also { pending.clear() }.forEach { it() }
	}
}

private class FakeHost : ReservationsHost {
	override val languageCode = "en"
	override val profile: CustomerProfile? = null
	override var resStack: List<String> = emptyList()
	override fun pushRes(key: String) { resStack = resStack + key }
	override fun replaceRes(key: String) { resStack = resStack.dropLast(1) + key }
	override fun popRes(): Boolean = resStack.isNotEmpty().also { if (it) resStack = resStack.dropLast(1) }
	override fun popResTo(key: String) { resStack = resStack.take(resStack.indexOf(key) + 1) }
	override fun notifyReservationsChanged() = Unit
}

class ReservationsControllerTests {
	private val access = makeAccessToken()

	private class Rig(
		val controller: ReservationsController,
		val storage: InMemoryReservationTokenStorage,
		val tasks: InlineTasks,
		val transport: StubTransport,
	)

	private fun rig(
		stored: Map<String, String> = emptyMap(),
		handler: (ApiRequest) -> ApiResponse,
	): Rig {
		val transport = StubTransport(handler)
		val configuration = makeConfiguration(origin = "https://acme.epic-startup.com")
		val session = CustomerSession(
			TenantApiClient(configuration, transport),
			InMemoryTokenStorage(AuthTokens(accessToken = access, refreshToken = "refresh")),
		)
		val storage = InMemoryReservationTokenStorage(stored)
		val tasks = InlineTasks()
		val controller = ReservationsController(
			app = FakeHost(),
			client = ReservationsClient(configuration, session, transport),
			storage = { storage },
			tasks = tasks,
		)
		return Rig(controller, storage, tasks, transport)
	}

	private fun fixture(name: String) = jsonResponse(200, ReservationFixtures.text(name))

	private fun Rig.withLocation(): ResLocation {
		controller.loadConfig()
		val location = controller.config!!.locations.first()
		controller.selectLocation(location)
		return location
	}

	private val waitKey = ReservationTokenKeys.waitlist("loc_pub_main")

	@Test
	fun partySizeCanStepAboveTheOnlineMaximumUpToTheLargePartyLimit() {
		val rig = rig { request ->
			if (request.url.contains("/config")) fixture("config") else fixture("availability")
		}
		val location = rig.withLocation()
		assertEquals(4, location.partyMax)
		assertEquals("request", location.largePartyMode)
		assertEquals(99, location.partyCeiling)

		rig.controller.setParty(9)
		assertEquals(9, rig.controller.selection?.partySize)
		assertTrue(location.needsApproval(9))
		assertFalse(location.needsApproval(4))
		rig.controller.setParty(500)
		assertEquals(99, rig.controller.selection?.partySize)
		rig.controller.setParty(0)
		assertEquals(location.partyMin, rig.controller.selection?.partySize)
	}

	@Test
	fun theAvailabilityRequestCarriesTheLargePartySize() {
		val rig = rig { request ->
			if (request.url.contains("/config")) fixture("config") else fixture("availability")
		}
		rig.withLocation()
		rig.controller.setParty(9)
		val search = rig.transport.requests.last { it.url.contains("/availability") }
		assertTrue(search.url.contains("partySize=9"), search.url)
	}

	@Test
	fun aLocationWithLargePartiesOffStopsAtTheOnlineMaximum() {
		val config = ReservationFixtures.json("config")
		config.getJSONArray("locations").getJSONObject(0).getJSONObject("largeParty").put("mode", "disabled")
		val rig = rig { request ->
			if (request.url.contains("/config")) jsonResponse(200, config.toString()) else fixture("availability")
		}
		val location = rig.withLocation()
		assertEquals(4, location.partyCeiling)
		rig.controller.setParty(9)
		assertEquals(4, rig.controller.selection?.partySize)
	}

	@Test
	fun aSavedWaitlistTokenIsRestoredIntoTheFlowAfterARestart() {
		val rig = rig(stored = mapOf(waitKey to "tok_wait_0001")) { request ->
			if (request.url.contains("/config")) fixture("config") else fixture("waitlist-status")
		}
		rig.withLocation()
		assertNull(rig.controller.waitlist.statusToken)

		rig.controller.openWaitlist()

		assertEquals("tok_wait_0001", rig.controller.waitlist.statusToken)
		assertEquals("waiting", rig.controller.waitlist.status?.status)
		val sent = rig.transport.requests.last()
		assertEquals("tok_wait_0001", sent.headers["X-Reservation-Token"])
		// The restored capability drives the follow-up actions.
		rig.controller.leaveWaitlist()
		val leave = rig.transport.requests.last()
		assertTrue(leave.url.contains("/waitlist/status/leave"), leave.url)
		assertEquals("tok_wait_0001", leave.headers["X-Reservation-Token"])
	}

	@Test
	fun anUnknownSavedWaitlistTokenIsClearedAndTheGuestReturnsToJoin() {
		val rig = rig(stored = mapOf(waitKey to "tok_dead_0001")) { request ->
			if (request.url.contains("/config")) fixture("config")
			else jsonResponse(404, """{"error":"not_found"}""")
		}
		rig.withLocation()

		rig.controller.openWaitlist()

		assertNull(rig.controller.waitlist.statusToken)
		assertNull(rig.storage.load()[waitKey])
	}

	@Test
	fun signOutClearsPersistedAndInMemoryStateForTheNextCustomer() {
		val rig = rig(
			stored = mapOf(
				waitKey to "tok_wait_0001",
				ReservationTokenKeys.manage("rsv_1") to "tok_manage_0001",
			),
		) { request ->
			when {
				request.url.contains("/config") -> fixture("config")
				request.url.contains("/mine") -> fixture("mine")
				else -> fixture("waitlist-status")
			}
		}
		rig.withLocation()
		rig.controller.loadMine()
		rig.controller.openWaitlist()
		rig.controller.setParty(9)
		assertNotNull(rig.controller.mine)
		assertNotNull(rig.controller.waitlist.statusToken)

		rig.controller.onSignedOut()

		assertNull(rig.controller.waitlist.statusToken)
		assertNull(rig.controller.waitlist.status)
		assertNull(rig.controller.mine)
		assertNull(rig.controller.config)
		assertNull(rig.controller.location)
		assertNull(rig.controller.selection)
		assertNull(rig.controller.detail)
		assertNull(rig.controller.requestLocalMin)
		assertTrue(rig.storage.load().isEmpty())

		// The next customer has no capability to refresh, leave or hurry.
		val before = rig.transport.requests.size
		rig.controller.refreshWaitlist()
		rig.controller.leaveWaitlist()
		rig.controller.waitlistOnMyWay()
		assertEquals(before, rig.transport.requests.size)
	}

	@Test
	fun anAnswerThatArrivesAfterSignOutIsDropped() {
		val rig = rig { request ->
			if (request.url.contains("/mine")) fixture("mine") else fixture("config")
		}
		rig.tasks.deferred = true
		rig.controller.loadMine()
		rig.controller.onSignedOut()
		rig.tasks.flush()
		assertNull(rig.controller.mine)
		// Nor may the previous customer's manage tokens be saved back.
		assertTrue(rig.storage.load().isEmpty())
	}
}
