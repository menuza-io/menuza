package com.epicstartup.tenant.core

import com.epicstartup.tenant.core.config.TenantConfiguration
import com.epicstartup.tenant.core.net.ApiRequest
import com.epicstartup.tenant.core.net.ApiResponse
import com.epicstartup.tenant.core.net.HttpTransport
import com.epicstartup.tenant.core.support.SiteAddress
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONObject

/** Records outgoing requests and replays canned responses. */
class StubTransport(
	private val handler: (ApiRequest) -> ApiResponse = { ApiResponse(200, ByteArray(0)) },
) : HttpTransport {
	private val recorded = CopyOnWriteArrayList<ApiRequest>()

	override fun send(request: ApiRequest): ApiResponse {
		recorded += request
		return handler(request)
	}

	val requests: List<ApiRequest> get() = recorded.toList()

	val lastRequest: ApiRequest? get() = recorded.lastOrNull()
}

fun jsonResponse(status: Int, body: String): ApiResponse =
	ApiResponse(statusCode = status, body = body.toByteArray(Charsets.UTF_8))

fun jsonBody(vararg pairs: Pair<String, Any?>): String = JSONObject().apply {
	pairs.forEach { (key, value) -> if (value != null) put(key, value) }
}.toString()

fun requestBodyJson(request: ApiRequest): JSONObject =
	JSONObject(String(request.body ?: ByteArray(0), Charsets.UTF_8))

fun makeConfiguration(
	slug: String? = "acme",
	host: String? = null,
	origin: String? = "https://acme.epic-startup.com",
	dataRegion: String = "us",
	appBaseUrl: String = "https://app.epic-startup.com",
	tenantApiUs: String = "https://tenant-us.epic-startup.com",
	tenantApiKsa: String? = "https://tenant-ksa.epic-startup.com",
): TenantConfiguration = TenantConfiguration(
	appBaseUrl = appBaseUrl,
	tenantApiBaseUrlUs = tenantApiUs,
	tenantApiBaseUrlKsa = tenantApiKsa,
	siteAddress = SiteAddress(slug = slug, host = host, origin = origin),
	dataRegion = dataRegion,
)

fun base64Url(value: String): String =
	Base64.getUrlEncoder().withoutPadding().encodeToString(value.toByteArray(Charsets.UTF_8))

/** Builds a (deliberately unsigned) JWT shaped like tenant-api's access token. */
fun makeAccessToken(
	customerId: String = "cus_1",
	orgId: String = "org_1",
	name: String? = "Jane Doe",
	expiresAtSeconds: Long = System.currentTimeMillis() / 1000 + 900,
): String {
	val payload = JSONObject().apply {
		put("customerId", customerId)
		put("orgId", orgId)
		if (name != null) put("name", name)
		put("exp", expiresAtSeconds)
	}
	return "${base64Url("""{"alg":"HS256","typ":"JWT"}""")}.${base64Url(payload.toString())}.signature"
}
