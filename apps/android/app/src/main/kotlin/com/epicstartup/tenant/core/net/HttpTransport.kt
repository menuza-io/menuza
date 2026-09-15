package com.epicstartup.tenant.core.net

import com.epicstartup.tenant.core.support.parseJsonObject
import java.net.HttpURLConnection
import java.net.URL

/** A blocking HTTP request, built by [TenantApiClient]. */
data class ApiRequest(
	val url: String,
	val method: String,
	val headers: Map<String, String> = emptyMap(),
	val body: ByteArray? = null,
	val timeoutMs: Int = 15_000,
) {
	// Data classes with a ByteArray need explicit equals/hashCode; requests are
	// only ever compared in tests, and identity is what those tests care about.
	override fun equals(other: Any?): Boolean = this === other
	override fun hashCode(): Int = System.identityHashCode(this)
}

data class ApiResponse(
	val statusCode: Int,
	val body: ByteArray,
)

/**
 * Transport seam so [TenantApiClient] and `CustomerSession` are testable without
 * a network (mirrors `HTTPTransport` in apps/ios).
 */
interface HttpTransport {
	fun send(request: ApiRequest): ApiResponse
}

/**
 * The shipping transport: `HttpURLConnection` from the framework.
 *
 * OkHttp/Retrofit would be a nicer API, but they are ~1.5 MB of the download for
 * a handful of short JSON calls — see the size budget in README.md.
 */
class HttpUrlConnectionTransport : HttpTransport {
	override fun send(request: ApiRequest): ApiResponse {
		val connection = URL(request.url).openConnection() as HttpURLConnection
		try {
			connection.requestMethod = request.method
			connection.connectTimeout = request.timeoutMs
			connection.readTimeout = request.timeoutMs
			connection.useCaches = false
			connection.instanceFollowRedirects = false
			request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }

			val body = request.body
			if (body != null) {
				connection.doOutput = true
				connection.setFixedLengthStreamingMode(body.size)
				connection.outputStream.use { it.write(body) }
			}

			val status = connection.responseCode
			val stream = if (status >= 400) connection.errorStream else connection.inputStream
			val payload = stream?.use { it.readBytes() } ?: ByteArray(0)
			return ApiResponse(statusCode = status, body = payload)
		} finally {
			connection.disconnect()
		}
	}
}

/** Errors surfaced by the tenant APIs. */
class ApiException(
	val statusCode: Int,
	override val message: String,
) : Exception(message) {
	val isUnauthorized: Boolean get() = statusCode == 401
	val isNotFound: Boolean get() = statusCode == 404
	val isRateLimited: Boolean get() = statusCode == 429
	val isTransportFailure: Boolean get() = statusCode == 0

	companion object {
		fun unauthorized(): ApiException = ApiException(401, "Please sign in again.")

		fun notBoundToTenant(): ApiException =
			ApiException(0, "This app is not connected to a site yet.")

		/**
		 * tenant-api returns `{ error, error_description? }`; the App returns
		 * `{ error }` or a plain-text 404. Prefer the most specific message.
		 */
		fun from(statusCode: Int, body: ByteArray): ApiException {
			val json = parseJsonObject(body)
			if (json != null) {
				json.optString("error_description", "").takeIf { it.isNotEmpty() }?.let {
					return ApiException(statusCode, it)
				}
				json.optString("error", "").takeIf { it.isNotEmpty() }?.let {
					return ApiException(statusCode, it)
				}
				json.optString("message", "").takeIf { it.isNotEmpty() }?.let {
					return ApiException(statusCode, it)
				}
			}
			val text = String(body, Charsets.UTF_8).trim()
			if (text.isNotEmpty() && text.length < 200) return ApiException(statusCode, text)
			return ApiException(statusCode, "Request failed ($statusCode)")
		}
	}
}
