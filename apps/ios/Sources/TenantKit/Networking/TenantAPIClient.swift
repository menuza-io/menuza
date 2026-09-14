import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Typed client for the two public APIs the tenant app depends on:
///
/// - **US control-plane App** (`/resources/sites`) for published org branding.
///   No customer PII.
/// - **Regional tenant-api** (`/auth/*`) for phone-OTP customer sessions and the
///   customer profile. This is the only place customer PII lives, and the app
///   talks to it directly — nothing is proxied through the control plane.
public struct TenantAPIClient: Sendable {
	public let configuration: TenantConfiguration
	private let transport: HTTPTransport

	public init(
		configuration: TenantConfiguration,
		transport: HTTPTransport = URLSessionTransport()
	) {
		self.configuration = configuration
		self.transport = transport
	}

	// MARK: - Published branding (App)

	public func fetchOrganization(locale: String? = nil) async throws -> PublicOrganization {
		var items = configuration.siteAddress.queryItems
		guard !items.isEmpty else { throw APIError.notBoundToTenant }
		if let locale, !locale.isEmpty {
			items.append(URLQueryItem(name: "lng", value: locale))
		}

		var request = try makeRequest(
			base: configuration.appBaseURL,
			path: "/resources/sites",
			queryItems: items
		)
		request.httpMethod = "GET"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		return try await send(request, as: PublicOrganization.self)
	}

	// MARK: - Customer auth (regional tenant-api)

	public func sendCode(phone: String) async throws {
		var body: [String: String] = ["phone": phone]
		applyBinding(to: &body)
		var request = try makeRequest(base: configuration.tenantAPIBaseURL, path: "/auth/send-code", queryItems: [])
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		applyBindingHeaders(to: &request)
		request.httpBody = try JSONSerialization.data(withJSONObject: body)
		_ = try await perform(request)
	}

	public func verify(phone: String, code: String) async throws -> VerifyResult {
		var body: [String: String] = ["phone": phone, "code": code]
		applyBinding(to: &body)
		var request = try makeRequest(base: configuration.tenantAPIBaseURL, path: "/auth/verify", queryItems: [])
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		applyBindingHeaders(to: &request)
		request.httpBody = try JSONSerialization.data(withJSONObject: body)

		let result = try await send(request, as: VerifyResult.self)
		guard let accessToken = result.accessToken, !accessToken.isEmpty else {
			throw APIError(statusCode: 400, message: result.error ?? "Verification failed")
		}
		return result
	}

	public func refresh(refreshToken: String, orgId: String) async throws -> AuthTokens {
		var request = try makeRequest(base: configuration.tenantAPIBaseURL, path: "/auth/refresh", queryItems: [])
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"refreshToken": refreshToken,
			"orgId": orgId,
		])

		let payload = try await send(request, as: VerifyResult.self)
		guard let accessToken = payload.accessToken, !accessToken.isEmpty else {
			throw APIError(statusCode: 401, message: "Session expired. Please sign in again.")
		}
		return AuthTokens(accessToken: accessToken, refreshToken: payload.refreshToken)
	}

	public func logout(refreshToken: String?, orgId: String?) async {
		guard let refreshToken, let orgId else { return }
		guard
			var request = try? makeRequest(base: configuration.tenantAPIBaseURL, path: "/auth/logout", queryItems: [])
		else { return }
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try? JSONSerialization.data(withJSONObject: [
			"refreshToken": refreshToken,
			"orgId": orgId,
		])
		_ = try? await perform(request)
	}

	public func fetchProfile(accessToken: String) async throws -> CustomerProfile {
		var request = try makeRequest(base: configuration.tenantAPIBaseURL, path: "/auth/me", queryItems: [])
		request.httpMethod = "GET"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
		let envelope = try await send(request, as: CustomerProfileEnvelope.self)
		guard let customer = envelope.customer else {
			throw APIError(statusCode: 404, message: "Customer not found")
		}
		return customer
	}

	public func updateProfile(
		name: String,
		email: String?,
		accessToken: String
	) async throws -> AuthTokens {
		var request = try makeRequest(base: configuration.tenantAPIBaseURL, path: "/auth/profile", queryItems: [])
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
		// `nil` means "leave the stored email alone"; an empty string clears it.
		var body: [String: String] = ["name": name]
		if let email {
			body["email"] = email
		}
		request.httpBody = try JSONSerialization.data(withJSONObject: body)

		let payload = try await send(request, as: VerifyResult.self)
		guard let nextAccessToken = payload.accessToken, !nextAccessToken.isEmpty else {
			throw APIError(statusCode: 400, message: payload.error ?? "Could not save your profile")
		}
		return AuthTokens(accessToken: nextAccessToken, refreshToken: payload.refreshToken)
	}

	// MARK: - Request plumbing

	/// tenant-api binds `send-code`/`verify` to the tenant the caller claims to
	/// be: slug or host in the body, plus the tenant's public site origin for
	/// https (production) origins — the same origin↔org rule Sites satisfies via
	/// its Host header. Local dev omits the header and relies on the body binding
	/// that tenant-api allows outside production.
	private func applyBinding(to body: inout [String: String]) {
		for item in configuration.siteAddress.queryItems {
			body[item.name] = item.value
		}
	}

	private func applyBindingHeaders(to request: inout URLRequest) {
		if let origin = configuration.siteAddress.authOriginHeader {
			request.setValue(origin, forHTTPHeaderField: "Origin")
		}
	}

	private func makeRequest(
		base: URL,
		path: String,
		queryItems: [URLQueryItem]
	) throws -> URLRequest {
		let baseURL = base.appendingPathComponent(path)
		guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
			throw APIError(statusCode: 0, message: "Invalid URL for \(path)")
		}
		if !queryItems.isEmpty {
			components.queryItems = queryItems
		}
		guard let url = components.url else {
			throw APIError(statusCode: 0, message: "Invalid URL for \(path)")
		}
		var request = URLRequest(url: url)
		request.timeoutInterval = configuration.requestTimeout
		return request
	}

	private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		do {
			let (data, response) = try await transport.send(request)
			guard (200..<300).contains(response.statusCode) else {
				throw APIError.from(statusCode: response.statusCode, data: data)
			}
			return (data, response)
		} catch let error as APIError {
			throw error
		} catch {
			throw APIError(statusCode: 0, message: error.localizedDescription)
		}
	}

	private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
		let (data, response) = try await perform(request)
		do {
			return try JSONDecoder().decode(T.self, from: data)
		} catch {
			throw APIError(
				statusCode: response.statusCode,
				message: "Unexpected response from \(response.url?.path ?? "the server")"
			)
		}
	}
}
