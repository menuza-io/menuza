package com.epicstartup.tenant.core

import com.epicstartup.tenant.core.model.AuthTokens
import com.epicstartup.tenant.core.net.ApiException
import com.epicstartup.tenant.core.net.ApiRequest
import com.epicstartup.tenant.core.net.ApiResponse
import com.epicstartup.tenant.core.net.HttpTransport
import com.epicstartup.tenant.core.net.TenantApiClient
import com.epicstartup.tenant.core.session.CustomerSession
import com.epicstartup.tenant.core.session.InMemoryTokenStorage
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A transport that can hold a response open, to pin down interleavings. */
private class GatedTransport(
	private val gateOn: (ApiRequest) -> Boolean = { true },
	private val handler: (ApiRequest) -> ApiResponse,
) : HttpTransport {
	private val entered = CountDownLatch(1)
	private val release = CountDownLatch(1)
	val requests = CopyOnWriteArrayList<ApiRequest>()

	override fun send(request: ApiRequest): ApiResponse {
		requests += request
		entered.countDown()
		if (gateOn(request)) release.await(5, TimeUnit.SECONDS)
		return handler(request)
	}

	fun awaitFirstRequest(): Boolean = entered.await(5, TimeUnit.SECONDS)

	fun releaseAll() = release.countDown()

	fun refreshRequests(): List<ApiRequest> = requests.filter { it.url.endsWith("/auth/refresh") }
}

class CustomerSessionTest {
	private val accessToken = makeAccessToken()
	private val refreshedToken = makeAccessToken(name = "Jane Doe")

	private fun session(
		storage: InMemoryTokenStorage = InMemoryTokenStorage(),
		handler: (ApiRequest) -> ApiResponse,
	): Pair<CustomerSession, StubTransport> {
		val transport = StubTransport(handler)
		val session = CustomerSession(TenantApiClient(makeConfiguration(), transport), storage)
		return session to transport
	}

	@Test
	fun verifyStoresTheSession() {
		val storage = InMemoryTokenStorage()
		val (session, transport) = session(storage) { _ ->
			jsonResponse(
				200,
				jsonBody("success" to true, "accessToken" to accessToken, "refreshToken" to "refresh_1"),
			)
		}

		val result = session.verify("+1 (555) 000-0000", " 123456 ")

		assertEquals(accessToken, result.accessToken)
		assertTrue(session.isSignedIn)
		assertEquals("org_1", session.tokens?.orgId)
		assertEquals("Jane", session.customerFirstName)
		assertEquals(accessToken, storage.load()?.accessToken)
		// The phone and code are normalized before they are sent, matching tenant-api.
		val body = requestBodyJson(assertNotNull(transport.lastRequest))
		assertEquals("+15550000000", body.getString("phone"))
		assertEquals("123456", body.getString("code"))
	}

	@Test
	fun sendCodeRejectsAnImplausiblePhoneBeforeCallingTheApi() {
		val (session, transport) = session { _ -> jsonResponse(200, jsonBody("success" to true)) }

		val error = assertFailsWith<ApiException> { session.sendCode("12") }

		assertEquals(400, error.statusCode)
		assertTrue(transport.requests.isEmpty())
	}

	@Test
	fun profileUsesTheStoredAccessToken() {
		val (session, transport) = session(InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))) { _ ->
			jsonResponse(200, jsonBody("customer" to mapOf("id" to "cus_1", "name" to "Jane Doe")))
		}

		val profile = session.profile()

		assertEquals("Jane Doe", profile.name)
		assertEquals("Bearer $accessToken", assertNotNull(transport.lastRequest).headers["Authorization"])
	}

	@Test
	fun authorizedRefreshesOnceAndRetriesAfterA401() {
		var meCalls = 0
		val (session, transport) = session(InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))) { request ->
			when {
				request.url.endsWith("/auth/refresh") -> jsonResponse(
					200,
					jsonBody("accessToken" to refreshedToken, "refreshToken" to "refresh_2"),
				)
				else -> {
					meCalls += 1
					if (meCalls == 1) {
						jsonResponse(401, jsonBody("error" to "Token expired"))
					} else {
						jsonResponse(200, jsonBody("customer" to mapOf("id" to "cus_1", "name" to "Jane")))
					}
				}
			}
		}

		val profile = session.profile()

		assertEquals("Jane", profile.name)
		assertEquals(2, meCalls)
		assertEquals(1, transport.requests.count { it.url.endsWith("/auth/refresh") })
		assertEquals("refresh_2", session.tokens?.refreshToken)
	}

	@Test
	fun authorizedClearsTheSessionWhenTheRefreshTokenIsDead() {
		val storage = InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))
		val (session, _) = session(storage) { request ->
			when {
				request.url.endsWith("/auth/refresh") -> jsonResponse(401, jsonBody("error" to "Invalid refresh token"))
				else -> jsonResponse(401, jsonBody("error" to "Token expired"))
			}
		}

		assertFailsWith<ApiException> { session.profile() }

		assertFalse(session.isSignedIn)
		assertNull(storage.load())
	}

	@Test
	fun transientRefreshFailuresKeepTheSession() {
		val storage = InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))
		val (session, _) = session(storage) { request ->
			when {
				request.url.endsWith("/auth/refresh") -> jsonResponse(500, jsonBody("error" to "Tenant Database unavailable"))
				else -> jsonResponse(401, jsonBody("error" to "Token expired"))
			}
		}

		assertFailsWith<ApiException> { session.profile() }

		assertTrue(session.isSignedIn)
		assertEquals("refresh_1", storage.load()?.refreshToken)
	}

	@Test
	fun concurrentRefreshesShareOneRotation() {
		val transport = GatedTransport { request ->
			when {
				request.url.endsWith("/auth/refresh") -> jsonResponse(
					200,
					jsonBody("accessToken" to refreshedToken, "refreshToken" to "refresh_2"),
				)
				else -> jsonResponse(200, jsonBody("customer" to mapOf("id" to "cus_1", "name" to "Jane")))
			}
		}
		val session = CustomerSession(
			TenantApiClient(makeConfiguration(), transport),
			InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1")),
		)

		val first = AtomicReference<AuthTokens?>()
		val second = AtomicReference<AuthTokens?>()
		val firstThread = Thread { first.set(session.refresh()) }
		firstThread.start()
		assertTrue(transport.awaitFirstRequest(), "the first refresh should reach the transport")

		val secondThread = Thread { second.set(session.refresh()) }
		secondThread.start()
		// Give the second caller time to join the in-flight refresh before the
		// first response is released.
		Thread.sleep(100)
		transport.releaseAll()
		firstThread.join(5_000)
		secondThread.join(5_000)

		assertEquals(1, transport.refreshRequests().size)
		assertEquals(refreshedToken, first.get()?.accessToken)
		assertEquals(refreshedToken, second.get()?.accessToken)
	}

	@Test
	fun aRefreshThatLandsAfterSignOutCannotRestoreTheSession() {
		val storage = InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))
		val transport = GatedTransport { request ->
			when {
				request.url.endsWith("/auth/refresh") -> jsonResponse(
					200,
					jsonBody("accessToken" to refreshedToken, "refreshToken" to "refresh_2"),
				)
				else -> jsonResponse(200, jsonBody("success" to true))
			}
		}
		val session = CustomerSession(TenantApiClient(makeConfiguration(), transport), storage)

		val failure = AtomicReference<Exception?>()
		val refreshThread = Thread {
			try {
				session.refresh()
			} catch (error: Exception) {
				failure.set(error)
			}
		}
		refreshThread.start()
		assertTrue(transport.awaitFirstRequest())

		session.signOut()
		transport.releaseAll()
		refreshThread.join(5_000)

		assertFalse(session.isSignedIn)
		assertNull(storage.load())
		assertNotNull(failure.get(), "the abandoned refresh must not adopt its tokens")
	}

	@Test
	fun aProfileUpdateThatLandsAfterSignOutCannotRestoreTheSession() {
		val storage = InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))
		val transport = GatedTransport(gateOn = { it.url.endsWith("/auth/profile") }) { request ->
			when {
				request.url.endsWith("/auth/profile") -> jsonResponse(
					200,
					jsonBody("accessToken" to refreshedToken, "refreshToken" to "refresh_2"),
				)
				else -> jsonResponse(200, jsonBody("success" to true))
			}
		}
		val session = CustomerSession(TenantApiClient(makeConfiguration(), transport), storage)

		val failure = AtomicReference<Exception?>()
		val updateThread = Thread {
			try {
				session.updateProfile("Jane Doe", null)
			} catch (error: Exception) {
				failure.set(error)
			}
		}
		updateThread.start()
		assertTrue(transport.awaitFirstRequest())

		session.signOut()
		transport.releaseAll()
		updateThread.join(5_000)

		assertFalse(session.isSignedIn)
		assertNull(storage.load())
		val error = assertNotNull(failure.get(), "the abandoned update must not adopt its tokens")
		assertTrue((error as ApiException).isUnauthorized)
	}

	@Test
	fun signOutRevokesTheRefreshTokenAndClearsTheSession() {
		val storage = InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))
		val (session, transport) = session(storage) { _ -> jsonResponse(200, jsonBody("success" to true)) }

		session.signOut()

		assertFalse(session.isSignedIn)
		assertNull(storage.load())
		val logout = assertNotNull(transport.requests.firstOrNull { it.url.endsWith("/auth/logout") })
		val body = requestBodyJson(logout)
		assertEquals("refresh_1", body.getString("refreshToken"))
		assertEquals("org_1", body.getString("orgId"))
	}

	@Test
	fun clearLocalSessionDropsTheSessionWithoutCallingTheApi() {
		val storage = InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))
		val (session, transport) = session(storage) { _ -> jsonResponse(200, jsonBody("success" to true)) }

		session.clearLocalSession()

		assertFalse(session.isSignedIn)
		assertNull(storage.load())
		// A session stored by another tenant must not be revoked through this
		// org's node: that node may be in the other data region.
		assertTrue(transport.requests.isEmpty())
	}

	@Test
	fun coalescedCallersSeeTheOriginalRefreshFailure() {
		val transport = GatedTransport { request ->
			when {
				request.url.endsWith("/auth/refresh") -> jsonResponse(
					401,
					jsonBody("error" to "invalid_grant"),
				)
				else -> jsonResponse(200, jsonBody("success" to true))
			}
		}
		val session = CustomerSession(
			TenantApiClient(makeConfiguration(), transport),
			InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1")),
		)

		val ownerFailure = AtomicReference<Exception?>()
		val joinedFailure = AtomicReference<Exception?>()
		val owner = Thread {
			try {
				session.refresh()
			} catch (error: Exception) {
				ownerFailure.set(error)
			}
		}
		owner.start()
		assertTrue(transport.awaitFirstRequest(), "the first refresh should reach the transport")

		val joined = Thread {
			try {
				session.refresh()
			} catch (error: Exception) {
				joinedFailure.set(error)
			}
		}
		joined.start()
		Thread.sleep(100)
		transport.releaseAll()
		owner.join(5_000)
		joined.join(5_000)

		// Both callers must see the status the owner saw: a flattened transport
		// failure would skip the sign-in prompt in `AppState.loadProfile`.
		assertEquals(401, (assertNotNull(ownerFailure.get()) as ApiException).statusCode)
		val joinedError = assertNotNull(joinedFailure.get()) as ApiException
		assertEquals(401, joinedError.statusCode)
		assertTrue(joinedError.isUnauthorized)
	}

	@Test
	fun updateProfileKeepsTheCurrentRefreshTokenWhenTheResponseOmitsIt() {
		val (session, _) = session(InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))) { request ->
			when {
				request.url.endsWith("/auth/profile") -> jsonResponse(200, jsonBody("accessToken" to refreshedToken))
				else -> jsonResponse(200, jsonBody("customer" to mapOf("id" to "cus_1", "name" to "Jane Doe")))
			}
		}

		session.updateProfile(name = "Jane Doe", email = null)

		assertEquals("refresh_1", session.tokens?.refreshToken)
	}

	@Test
	fun updateProfileRejectsATooShortName() {
		val (session, transport) = session(InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))) { _ ->
			jsonResponse(200, jsonBody("success" to true))
		}

		val error = assertFailsWith<ApiException> { session.updateProfile(name = " J ", email = null) }

		assertEquals(400, error.statusCode)
		assertTrue(transport.requests.isEmpty())
	}

	@Test
	fun restoreLoadsAPreviouslyStoredSession() {
		val storage = InMemoryTokenStorage(AuthTokens(accessToken, "refresh_1"))
		val session = CustomerSession(TenantApiClient(makeConfiguration(), StubTransport()), storage)

		assertTrue(session.isSignedIn)
		assertEquals(accessToken, session.restore()?.accessToken)
	}
}
