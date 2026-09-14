package com.epicstartup.tenant.core

import com.epicstartup.tenant.core.config.TenantConfiguration
import com.epicstartup.tenant.core.net.ApiException
import com.epicstartup.tenant.core.net.TenantApiClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TenantApiClientTest {
	private fun client(
		slug: String? = "acme",
		host: String? = null,
		origin: String? = "https://acme.epic-startup.com",
		handler: (com.epicstartup.tenant.core.net.ApiRequest) -> com.epicstartup.tenant.core.net.ApiResponse,
	): Pair<TenantApiClient, StubTransport> {
		val transport = StubTransport(handler)
		val configuration = makeConfiguration(slug = slug, host = host, origin = origin)
		return TenantApiClient(configuration, transport) to transport
	}

	@Test
	fun fetchOrganizationUsesSlugBindingAndDecodesBranding() {
		val (client, transport) = client { _ ->
			jsonResponse(
				200,
				jsonBody(
					"id" to "org_1",
					"name" to "Acme Coffee",
					"slug" to "acme",
					"dataRegion" to "us",
					"locales" to listOf("en", "ar"),
					"defaultLocale" to "en",
					"siteIcon" to mapOf("original" to "/resources/images?objectKey=org%2Facme%2Ficon.png"),
					"theme" to mapOf(
						"baseColor" to "neutral",
						"theme" to "amber",
						"mode" to "system",
						"headingFont" to "space-grotesk",
						"bodyFont" to "inter",
						"css" to "html { --primary: oklch(0.205 0 0); }",
					),
					"announcements" to listOf(
						mapOf(
							"id" to "ann_1",
							"content" to "Free delivery this week",
							"type" to "info",
							"linkUrl" to "/shop",
							"linkLabel" to "Shop",
							"linkNewTab" to false,
						),
					),
				),
			)
		}

		val organization = client.fetchOrganization(locale = "ar", acceptLanguage = "en-US, ar")

		assertEquals("Acme Coffee", organization.name)
		assertEquals("us", organization.resolvedDataRegion)
		assertEquals(listOf("en", "ar"), organization.resolvedLocales)
		assertEquals("amber", organization.theme?.theme)
		assertEquals("Free delivery this week", organization.announcements?.first()?.content)
		assertEquals(
			"https://app.epic-startup.com/resources/images?objectKey=org%2Facme%2Ficon.png",
			organization.iconUrl("https://app.epic-startup.com"),
		)

		val request = assertNotNull(transport.lastRequest)
		assertTrue(request.url.startsWith("https://app.epic-startup.com/resources/sites?"))
		assertTrue(request.url.contains("slug=acme"))
		assertTrue(request.url.contains("lng=ar"))
		assertEquals("en-US, ar", request.headers["Accept-Language"])
	}

	@Test
	fun fetchOrganizationUsesCustomDomainBinding() {
		val (client, transport) = client(slug = null, host = "www.acme.com") { _ ->
			jsonResponse(200, jsonBody("id" to "org_2", "name" to "Custom", "slug" to "custom"))
		}

		client.fetchOrganization()

		val request = assertNotNull(transport.lastRequest)
		assertTrue(request.url.contains("host=www.acme.com"))
		assertTrue(!request.url.contains("slug="))
	}

	@Test
	fun unboundClientRefusesToCallTheSiteApi() {
		val (client, _) = client(slug = null, host = null) { jsonResponse(200, "{}") }

		val error = assertFailsWith<ApiException> { client.fetchOrganization() }
		assertEquals(0, error.statusCode)
		assertTrue(error.isTransportFailure)
	}

	@Test
	fun sendCodeSendsTheTenantBindingAndOriginHeader() {
		val (client, transport) = client { _ -> jsonResponse(200, jsonBody("success" to true)) }

		client.sendCode("+15550000000")

		val request = assertNotNull(transport.lastRequest)
		assertEquals("POST", request.method)
		assertEquals("https://tenant-us.epic-startup.com/auth/send-code", request.url)
		assertEquals("https://acme.epic-startup.com", request.headers["Origin"])
		val body = requestBodyJson(request)
		assertEquals("+15550000000", body.getString("phone"))
		assertEquals("acme", body.getString("slug"))
	}

	@Test
	fun sendCodeOmitsTheOriginHeaderOutsideProduction() {
		val (client, transport) = client(origin = "http://acme.epic-startup.test:3010") { _ ->
			jsonResponse(200, jsonBody("success" to true))
		}

		client.sendCode("+15550000000")

		assertNull(assertNotNull(transport.lastRequest).headers["Origin"])
	}

	@Test
	fun verifyReturnsTokensAndSurfacesServerErrors() {
		val (client, _) = client { _ ->
			jsonResponse(400, jsonBody("error" to "Invalid or expired code"))
		}

		val error = assertFailsWith<ApiException> { client.verify("+15550000000", "123456") }
		assertEquals(400, error.statusCode)
		assertEquals("Invalid or expired code", error.message)
	}

	@Test
	fun verifyReturnsTheSessionTokens() {
		val token = makeAccessToken()
		val (client, _) = client { _ ->
			jsonResponse(
				200,
				jsonBody(
					"success" to true,
					"accessToken" to token,
					"refreshToken" to "refresh_1",
					"needsName" to true,
				),
			)
		}

		val result = client.verify("+15550000000", "123456")
		assertEquals(token, result.accessToken)
		assertEquals("refresh_1", result.refreshToken)
		assertEquals(true, result.needsName)
	}

	@Test
	fun verifyRejectsAnEmptyAccessToken() {
		val (client, _) = client { _ -> jsonResponse(200, jsonBody("success" to true)) }

		val error = assertFailsWith<ApiException> { client.verify("+15550000000", "123456") }
		assertEquals(400, error.statusCode)
	}

	@Test
	fun refreshReturnsRotatedTokens() {
		val token = makeAccessToken()
		val (client, transport) = client { _ ->
			jsonResponse(200, jsonBody("accessToken" to token, "refreshToken" to "refresh_2"))
		}

		val tokens = client.refresh(refreshToken = "refresh_1", orgId = "org_1")

		assertEquals(token, tokens.accessToken)
		assertEquals("refresh_2", tokens.refreshToken)
		val body = requestBodyJson(assertNotNull(transport.lastRequest))
		assertEquals("refresh_1", body.getString("refreshToken"))
		assertEquals("org_1", body.getString("orgId"))
	}

	@Test
	fun fetchProfileUnwrapsTheEnvelope() {
		val (client, transport) = client { _ ->
			jsonResponse(
				200,
				jsonBody(
					"customer" to mapOf(
						"id" to "cus_1",
						"name" to "Jane Doe",
						"email" to "jane@example.com",
						"phone" to "+15550000000",
						"needsName" to false,
					),
				),
			)
		}

		val profile = client.fetchProfile("access_1")

		assertEquals("Jane Doe", profile.name)
		assertEquals("jane@example.com", profile.email)
		assertEquals("Bearer access_1", assertNotNull(transport.lastRequest).headers["Authorization"])
	}

	@Test
	fun fetchProfileReportsAMissingCustomer() {
		val (client, _) = client { _ -> jsonResponse(200, jsonBody("customer" to null)) }

		val error = assertFailsWith<ApiException> { client.fetchProfile("access_1") }
		assertEquals(404, error.statusCode)
	}

	@Test
	fun updateProfileOmitsTheEmailWhenItWasNotEdited() {
		val token = makeAccessToken()
		val (client, transport) = client { _ ->
			jsonResponse(200, jsonBody("accessToken" to token, "refreshToken" to "refresh_2"))
		}

		client.updateProfile(name = "Jane Doe", email = null, accessToken = "access_1")

		val body = requestBodyJson(assertNotNull(transport.lastRequest))
		assertEquals("Jane Doe", body.getString("name"))
		assertTrue(!body.has("email"))
	}

	@Test
	fun updateProfileSendsAnEmptyEmailWhenTheCustomerClearedIt() {
		val token = makeAccessToken()
		val (client, transport) = client { _ ->
			jsonResponse(200, jsonBody("accessToken" to token))
		}

		client.updateProfile(name = "Jane Doe", email = "", accessToken = "access_1")

		val body = requestBodyJson(assertNotNull(transport.lastRequest))
		assertEquals("", body.getString("email"))
	}

	@Test
	fun transportFailuresBecomeStatusZero() {
		val transport = StubTransport { throw java.io.IOException("offline") }
		val client = TenantApiClient(makeConfiguration(), transport)

		val error = assertFailsWith<ApiException> { client.fetchOrganization() }
		assertEquals(0, error.statusCode)
		assertTrue(error.isTransportFailure)
	}
}

class ApiExceptionTest {
	@Test
	fun prefersTheMostSpecificServerMessage() {
		assertEquals(
			"Too many attempts",
			ApiException.from(429, jsonBody("error" to "rate_limit", "error_description" to "Too many attempts").toByteArray())
				.message,
		)
		assertEquals(
			"rate_limit",
			ApiException.from(429, jsonBody("error" to "rate_limit").toByteArray()).message,
		)
		assertEquals(
			"Something broke",
			ApiException.from(500, jsonBody("message" to "Something broke").toByteArray()).message,
		)
		assertEquals(
			"plain text error",
			ApiException.from(404, "plain text error".toByteArray()).message,
		)
		assertEquals("Request failed (503)", ApiException.from(503, ByteArray(0)).message)
	}

	@Test
	fun classifiesStatusCodes() {
		assertTrue(ApiException.from(401, ByteArray(0)).isUnauthorized)
		assertTrue(ApiException.from(429, ByteArray(0)).isRateLimited)
		assertTrue(ApiException.from(404, ByteArray(0)).isNotFound)
	}
}

class TenantConfigurationTest {
	@Test
	fun normalizesHostsIntoUrls() {
		val configuration = TenantConfiguration.from(
			appUrl = "app.epic-startup.com",
			tenantApiUs = "tenant-us.epic-startup.com",
			tenantApiKsa = "tenant-ksa.epic-startup.com",
			useTls = true,
			brandDomain = "epic-startup.com",
			siteSlug = "acme",
			siteHost = null,
			siteOrigin = "https://acme.epic-startup.com",
			requestTimeoutMs = 15_000,
		)
		assertEquals("https://app.epic-startup.com", configuration.appBaseUrl)
		assertEquals("https://tenant-us.epic-startup.com", configuration.tenantApiBaseUrlUs)
		assertEquals("https://tenant-ksa.epic-startup.com", configuration.tenantApiBaseUrlKsa)
		assertTrue(configuration.isBoundToTenant)
	}

	@Test
	fun refusesCleartextToANonLoopbackHost() {
		assertTrue(TenantConfiguration.isTransportSafe("https://example.com"))
		assertTrue(TenantConfiguration.isTransportSafe("http://localhost:3001"))
		assertTrue(TenantConfiguration.isTransportSafe("http://127.0.0.1:3001"))
		assertTrue(TenantConfiguration.isTransportSafe("http://10.0.2.2:3001"))
		assertTrue(TenantConfiguration.isTransportSafe("http://acme.localhost:3010"))
		assertTrue(!TenantConfiguration.isTransportSafe("http://example.com"))
		assertTrue(!TenantConfiguration.isTransportSafe("ftp://example.com"))
		assertTrue(!TenantConfiguration.isTransportSafe("example.com"))
	}

	@Test
	fun refusesHostlessAndUserInfoUrls() {
		assertTrue(!TenantConfiguration.isTransportSafe("https://"))
		assertTrue(!TenantConfiguration.isTransportSafe("https:///path"))
		assertTrue(!TenantConfiguration.isTransportSafe("https://user:secret@example.com"))
		// The host that matters is the one the request reaches, not the text
		// before the `@`.
		assertTrue(!TenantConfiguration.isTransportSafe("http://localhost@evil.example"))
		// `127.` is a name here, not an IPv4 loopback address.
		assertTrue(!TenantConfiguration.isTransportSafe("http://127.example.com"))
		assertTrue(!TenantConfiguration.isTransportSafe("http://127.0.0.1.evil.example"))
		assertTrue(!TenantConfiguration.isTransportSafe("http://127.0.0.256:3001"))
		assertTrue(TenantConfiguration.isTransportSafe("http://127.10.20.30:3001"))
	}

	@Test
	fun fallsBackToTheLocalDevelopmentDefaultsWhenAMisconfiguredUrlIsRefused() {
		val configuration = TenantConfiguration.from(
			appUrl = "http://evil.example.com",
			tenantApiUs = "http://evil.example.com",
			tenantApiKsa = null,
			useTls = false,
			brandDomain = "",
			siteSlug = null,
			siteHost = null,
			siteOrigin = null,
			requestTimeoutMs = 0,
		)
		assertEquals("http://localhost:3001", configuration.appBaseUrl)
		assertEquals("http://localhost:3007", configuration.tenantApiBaseUrlUs)
		assertNull(configuration.tenantApiBaseUrlKsa)
		assertEquals("epic-startup.test", configuration.brandDomain)
		assertEquals(15_000, configuration.requestTimeoutMs)
		assertTrue(!configuration.isBoundToTenant)
	}

	@Test
	fun selectsTheRegionalNode() {
		val configuration = makeConfiguration(dataRegion = "ksa")
		assertEquals("https://tenant-ksa.epic-startup.com", configuration.tenantApiBaseUrl)
		assertEquals(
			"https://tenant-us.epic-startup.com",
			configuration.withDataRegion("us").tenantApiBaseUrl,
		)
		// A deployment without a KSA node keeps serving the US node rather than
		// inventing an origin.
		assertEquals(
			"https://tenant-us.epic-startup.com",
			makeConfiguration(dataRegion = "ksa", tenantApiKsa = null).tenantApiBaseUrl,
		)
	}
}
