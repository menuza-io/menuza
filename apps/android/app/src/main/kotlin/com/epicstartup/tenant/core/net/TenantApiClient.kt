package com.epicstartup.tenant.core.net

import com.epicstartup.tenant.core.config.TenantConfiguration
import com.epicstartup.tenant.core.model.AuthTokens
import com.epicstartup.tenant.core.model.CustomerProfile
import com.epicstartup.tenant.core.model.PublicOrganization
import com.epicstartup.tenant.core.model.VerifyResult
import com.epicstartup.tenant.core.support.objectOrNull
import com.epicstartup.tenant.core.support.parseJsonObject
import java.net.URLEncoder
import org.json.JSONObject

/**
 * Typed client for the two public APIs the tenant app depends on:
 *
 * - **US control-plane App** (`/resources/sites`) for published org branding.
 *   No customer PII.
 * - **Regional tenant-api** (`/auth/…`) for phone-OTP customer sessions and the
 *   customer profile. This is the only place customer PII lives, and the app
 *   talks to it directly — nothing is proxied through the control plane.
 *
 * Every call blocks; the UI layer runs them on a background executor.
 */
class TenantApiClient(
	val configuration: TenantConfiguration,
	private val transport: HttpTransport = HttpUrlConnectionTransport(),
) {

	// MARK: - Published branding (App)

	fun fetchOrganization(locale: String? = null, acceptLanguage: String? = null): PublicOrganization {
		val query = configuration.siteAddress.queryItems.toMutableList()
		if (query.isEmpty()) throw ApiException.notBoundToTenant()
		if (!locale.isNullOrEmpty()) query += "lng" to locale

		val headers = mutableMapOf("Accept" to "application/json")
		// The App negotiates the response locale from Accept-Language, the same
		// way URLSession does for the iOS app.
		if (!acceptLanguage.isNullOrBlank()) headers["Accept-Language"] = acceptLanguage

		val request = buildRequest(
			baseUrl = configuration.appBaseUrl,
			path = "/resources/sites",
			query = query,
		).copy(headers = headers)

		val body = perform(request)
		val json = parseJsonObject(body)
			?: throw ApiException(200, "Unexpected response from /resources/sites")
		return PublicOrganization.fromJson(json)
			?: throw ApiException(200, "Unexpected response from /resources/sites")
	}

	// MARK: - Customer auth (regional tenant-api)

	fun sendCode(phone: String) {
		val payload = JSONObject().apply {
			put("phone", phone)
			applyBinding(this)
		}
		val request = buildRequest(
			baseUrl = configuration.tenantApiBaseUrl,
			path = "/auth/send-code",
			query = emptyList(),
		).copy(
			method = "POST",
			headers = jsonHeaders(withBindingOrigin = true),
			body = payload.toString().toByteArray(Charsets.UTF_8),
		)
		perform(request)
	}

	fun verify(phone: String, code: String): VerifyResult {
		val payload = JSONObject().apply {
			put("phone", phone)
			put("code", code)
			applyBinding(this)
		}
		val request = buildRequest(
			baseUrl = configuration.tenantApiBaseUrl,
			path = "/auth/verify",
			query = emptyList(),
		).copy(
			method = "POST",
			headers = jsonHeaders(withBindingOrigin = true),
			body = payload.toString().toByteArray(Charsets.UTF_8),
		)

		val result = send(request, "/auth/verify") { VerifyResult.fromJson(it) }
		if (result.accessToken.isNullOrEmpty()) {
			throw ApiException(400, result.error ?: "Verification failed")
		}
		return result
	}

	fun refresh(refreshToken: String, orgId: String): AuthTokens {
		val payload = JSONObject().apply {
			put("refreshToken", refreshToken)
			put("orgId", orgId)
		}
		val request = buildRequest(
			baseUrl = configuration.tenantApiBaseUrl,
			path = "/auth/refresh",
			query = emptyList(),
		).copy(
			method = "POST",
			headers = jsonHeaders(),
			body = payload.toString().toByteArray(Charsets.UTF_8),
		)

		val result = send(request, "/auth/refresh") { VerifyResult.fromJson(it) }
		val accessToken = result.accessToken
		if (accessToken.isNullOrEmpty()) {
			throw ApiException(401, "Session expired. Please sign in again.")
		}
		return AuthTokens(accessToken = accessToken, refreshToken = result.refreshToken)
	}

	fun logout(refreshToken: String?, orgId: String?) {
		if (refreshToken == null || orgId == null) return
		val payload = JSONObject().apply {
			put("refreshToken", refreshToken)
			put("orgId", orgId)
		}
		val request = buildRequest(
			baseUrl = configuration.tenantApiBaseUrl,
			path = "/auth/logout",
			query = emptyList(),
		).copy(
			method = "POST",
			headers = jsonHeaders(),
			body = payload.toString().toByteArray(Charsets.UTF_8),
		)
		runCatching { perform(request) }
	}

	fun fetchProfile(accessToken: String): CustomerProfile {
		val request = buildRequest(
			baseUrl = configuration.tenantApiBaseUrl,
			path = "/auth/me",
			query = emptyList(),
		).copy(
			headers = mapOf(
				"Accept" to "application/json",
				"Authorization" to "Bearer $accessToken",
			),
		)

		val envelope = parseJsonObject(perform(request))
			?: throw ApiException(200, "Unexpected response from /auth/me")
		val customer = envelope.objectOrNull("customer")
			?: throw ApiException(404, "Customer not found")
		return CustomerProfile.fromJson(customer)
	}

	fun updateProfile(name: String, email: String?, accessToken: String): AuthTokens {
		val payload = JSONObject().apply {
			put("name", name)
			// `null` means "leave the stored email alone"; an empty string clears it.
			if (email != null) put("email", email)
		}
		val request = buildRequest(
			baseUrl = configuration.tenantApiBaseUrl,
			path = "/auth/profile",
			query = emptyList(),
		).copy(
			method = "POST",
			headers = mapOf(
				"Accept" to "application/json",
				"Content-Type" to "application/json",
				"Authorization" to "Bearer $accessToken",
			),
			body = payload.toString().toByteArray(Charsets.UTF_8),
		)

		val result = send(request, "/auth/profile") { VerifyResult.fromJson(it) }
		val nextAccessToken = result.accessToken
		if (nextAccessToken.isNullOrEmpty()) {
			throw ApiException(400, result.error ?: "Could not save your profile")
		}
		return AuthTokens(accessToken = nextAccessToken, refreshToken = result.refreshToken)
	}

	// MARK: - Request plumbing

	/**
	 * tenant-api binds `send-code`/`verify` to the tenant the caller claims to
	 * be: slug or host in the body, plus the tenant's public site origin for
	 * https (production) origins — the same origin↔org rule Sites satisfies via
	 * its Host header. Local dev omits the header and relies on the body binding
	 * that tenant-api allows outside production.
	 */
	private fun applyBinding(payload: JSONObject) {
		for ((name, value) in configuration.siteAddress.queryItems) {
			payload.put(name, value)
		}
	}

	private fun jsonHeaders(withBindingOrigin: Boolean = false): Map<String, String> {
		val headers = mutableMapOf(
			"Accept" to "application/json",
			"Content-Type" to "application/json",
		)
		if (withBindingOrigin) {
			configuration.siteAddress.authOriginHeader?.let { headers["Origin"] = it }
		}
		return headers
	}

	private fun buildRequest(
		baseUrl: String,
		path: String,
		query: List<Pair<String, String>>,
	): ApiRequest {
		val url = buildString {
			append(baseUrl.trimEnd('/'))
			append(path)
			if (query.isNotEmpty()) {
				append('?')
				append(
					query.joinToString("&") { (name, value) ->
						"${encode(name)}=${encode(value)}"
					},
				)
			}
		}
		return ApiRequest(url = url, method = "GET", timeoutMs = configuration.requestTimeoutMs)
	}

	private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

	private fun perform(request: ApiRequest): ByteArray {
		val response = try {
			transport.send(request)
		} catch (error: ApiException) {
			throw error
		} catch (error: Exception) {
			throw ApiException(0, error.message ?: "Network error")
		}
		if (response.statusCode !in 200..299) {
			throw ApiException.from(response.statusCode, response.body)
		}
		return response.body
	}

	private fun <T> send(request: ApiRequest, path: String, decode: (JSONObject) -> T): T {
		val body = perform(request)
		val json = parseJsonObject(body)
			?: throw ApiException(200, "Unexpected response from $path")
		return decode(json)
	}
}
