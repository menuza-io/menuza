import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Typed client for the public `/reservations/*` routes of the regional
/// tenant-api. The app talks to the node that owns the organization's data
/// directly; nothing is proxied through the control plane.
///
/// Every call
/// - goes through `CustomerSession.authorized`, so it carries the customer's
///   `Authorization: Bearer` token (a verified customer stands in for Turnstile)
///   and gets one transparent refresh on `401`,
/// - sends `X-Client: ios` (the server records channel `native`),
/// - sends the tenant binding: the site `Origin` for https sites and the
///   `slug`/`host` query that tenant-api accepts outside production, exactly as
///   the sign-in calls do.
///
/// Mutations are POST only. A hold, manage or waitlist token travels in the
/// `X-Reservation-Token` header, never in a URL. The one exception is the `.ics`
/// download, which the app does not use. Tokens and guest details are never
/// logged: errors carry only the stable `error` code.
public struct ReservationsClient: Sendable {
	public static let clientHeaderValue = "ios"

	public let configuration: TenantConfiguration
	private let session: CustomerSession
	private let transport: HTTPTransport

	public init(
		configuration: TenantConfiguration,
		session: CustomerSession,
		transport: HTTPTransport = URLSessionTransport()
	) {
		self.configuration = configuration
		self.session = session
		self.transport = transport
	}

	// MARK: - Discovery

	public func config(locale: String? = nil) async throws -> ReservationsConfig {
		try await get("/reservations/config", query: ["locale": locale])
	}

	public func availability(
		locationId: String,
		date: String,
		partySize: Int,
		localMin: Int? = nil,
		locale: String? = nil
	) async throws -> ReservationAvailability {
		try await get(
			"/reservations/availability",
			query: [
				"locationId": locationId,
				"date": date,
				"partySize": String(partySize),
				"localMin": localMin.map(String.init),
				"locale": locale,
			]
		)
	}

	public func calendar(
		locationId: String,
		partySize: Int,
		from: String,
		to: String
	) async throws -> ReservationCalendar {
		try await get(
			"/reservations/calendar",
			query: [
				"locationId": locationId,
				"partySize": String(partySize),
				"from": from,
				"to": to,
			]
		)
	}

	// MARK: - Holds and bookings

	/// Holds a table for `ReservationLocation.holdMinutes`. A hold the guest
	/// abandons is released with `releaseHold`; replacing a hold passes the old
	/// token so the slot is never double-held.
	public func createHold(
		locationId: String,
		date: String,
		localMin: Int,
		partySize: Int,
		serviceId: String? = nil,
		areaId: String? = nil,
		replaceHoldToken: String? = nil
	) async throws -> ReservationHold {
		var slot: [String: Any] = ["date": date, "localMin": localMin, "partySize": partySize]
		if let serviceId { slot["serviceId"] = serviceId }
		var body: [String: Any] = ["locationId": locationId, "slot": slot]
		if let areaId { body["areaPref"] = areaId }
		if let replaceHoldToken { body["replaceHoldToken"] = replaceHoldToken }
		return try await post("/reservations/holds", body: body)
	}

	public func releaseHold(holdToken: String) async throws {
		let _: ReleaseResponse = try await post(
			"/reservations/holds/release",
			body: ["holdToken": holdToken]
		)
	}

	/// Books a hold. The `Idempotency-Key` is chosen by the caller (the booking
	/// flow) so a retry after a network error reuses it and the server replays
	/// the first answer instead of booking twice.
	public func book(
		holdToken: String,
		details: ReservationGuestDetails,
		idempotencyKey: String
	) async throws -> ReservationBooking {
		var body = Self.detailsBody(details)
		body["holdToken"] = holdToken
		return try await post(
			"/reservations",
			body: body,
			headers: ["Idempotency-Key": idempotencyKey]
		)
	}

	/// Sends a large-party request (no hold). The booking is `requested` until
	/// the restaurant approves it.
	public func requestLargeParty(
		locationId: String,
		date: String,
		localMin: Int,
		partySize: Int,
		details: ReservationGuestDetails,
		idempotencyKey: String
	) async throws -> ReservationBooking {
		var body = Self.detailsBody(details)
		body["locationId"] = locationId
		body["slot"] = ["date": date, "localMin": localMin, "partySize": partySize] as [String: Any]
		return try await post(
			"/reservations/requests",
			body: body,
			headers: ["Idempotency-Key": idempotencyKey]
		)
	}

	/// The signed-in customer's bookings with fresh manage tokens (recovers
	/// tokens after a reinstall).
	public func mine() async throws -> ReservationMine {
		try await get("/reservations/mine")
	}

	// MARK: - Manage (capability token in X-Reservation-Token)

	public func manage(token: String) async throws -> ReservationManageView {
		try await get("/reservations/manage", token: token)
	}

	public func manageAvailability(
		token: String,
		date: String? = nil,
		partySize: Int? = nil,
		localMin: Int? = nil
	) async throws -> ReservationAvailability {
		try await get(
			"/reservations/manage/availability",
			query: [
				"date": date,
				"partySize": partySize.map(String.init),
				"localMin": localMin.map(String.init),
			],
			token: token
		)
	}

	public func modify(
		token: String,
		date: String? = nil,
		localMin: Int,
		partySize: Int? = nil
	) async throws -> ReservationManageView {
		var body: [String: Any] = ["localMin": localMin]
		if let date { body["date"] = date }
		if let partySize { body["partySize"] = partySize }
		return try await post("/reservations/manage/modify", body: body, token: token)
	}

	public func cancel(token: String) async throws -> ReservationManageView {
		try await post("/reservations/manage/cancel", body: [:], token: token)
	}

	/// Confirms attendance when the restaurant asked for it.
	public func confirm(token: String) async throws -> ReservationManageView {
		try await post("/reservations/manage/confirm", body: [:], token: token)
	}

	public func runningLate(token: String, minutes: Int) async throws -> ReservationManageView {
		try await post("/reservations/manage/running-late", body: ["minutes": minutes], token: token)
	}

	/// The payment status poll: exactly `{ paymentStatus, reservationStatus, now }`.
	/// The token may be the manage token or the booking's payment token.
	public func paymentStatus(token: String) async throws -> ReservationPaymentStatus {
		try await get("/reservations/manage/payment", token: token)
	}

	// MARK: - Waitlist

	public func joinWaitlist(
		locationId: String,
		name: String,
		partySize: Int,
		phone: String,
		smsOptIn: Bool,
		locale: String?,
		idempotencyKey: String
	) async throws -> ReservationWaitlistJoin {
		var body: [String: Any] = [
			"locationId": locationId,
			"name": name,
			"partySize": partySize,
			"phone": phone,
			"smsOptIn": smsOptIn,
		]
		if let locale { body["locale"] = locale }
		return try await post(
			"/reservations/waitlist/join",
			body: body,
			headers: ["Idempotency-Key": idempotencyKey]
		)
	}

	public func waitlistStatus(token: String) async throws -> ReservationWaitlistStatus {
		try await get("/reservations/waitlist/status", token: token)
	}

	public func leaveWaitlist(token: String) async throws -> ReservationWaitlistStatus {
		try await post("/reservations/waitlist/status/leave", body: [:], token: token)
	}

	public func waitlistOnMyWay(token: String) async throws -> ReservationWaitlistStatus {
		try await post("/reservations/waitlist/status/on-my-way", body: [:], token: token)
	}

	// MARK: - Request plumbing

	private struct ReleaseResponse: Decodable {
		let released: Bool?
	}

	/// The JSON body of `book` and `requestLargeParty`; both use the same guest
	/// block as Sites.
	static func detailsBody(_ details: ReservationGuestDetails) -> [String: Any] {
		var guest: [String: Any] = [
			"firstName": details.firstName.trimmingCharacters(in: .whitespacesAndNewlines),
			"lastName": details.lastName.trimmingCharacters(in: .whitespacesAndNewlines),
			"phone": details.phone,
		]
		let email = details.email.trimmingCharacters(in: .whitespacesAndNewlines)
		if !email.isEmpty { guest["email"] = email }

		var body: [String: Any] = [
			"guest": guest,
			"locale": details.locale,
			"smsOptIn": details.smsOptIn,
			// The honeypot stays empty; a native app has no Turnstile token (the
			// customer token stands in for it).
			"website": "",
		]
		if let occasion = details.occasionTagId { body["occasionTagId"] = occasion }
		let requests = details.requests.trimmingCharacters(in: .whitespacesAndNewlines)
		if !requests.isEmpty { body["requests"] = requests }
		let dietary = details.dietary.trimmingCharacters(in: .whitespacesAndNewlines)
		if !dietary.isEmpty { body["dietary"] = dietary }
		if let area = details.areaId { body["areaPref"] = area }
		if let version = details.policyTermsVersion {
			body["policyAccepted"] = ["termsVersion": version]
		}
		return body
	}

	func makeRequest(
		method: String,
		path: String,
		query: [String: String?] = [:],
		body: [String: Any]? = nil,
		headers: [String: String] = [:],
		token: String? = nil,
		accessToken: String
	) throws -> URLRequest {
		let baseURL = configuration.tenantAPIBaseURL.appendingPathComponent(path)
		guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
			throw APIError(statusCode: 0, message: "Invalid URL")
		}
		// Binding first, then the call's own parameters in a stable order.
		var items = configuration.siteAddress.queryItems
		for key in query.keys.sorted() {
			if let value = query[key] ?? nil, !value.isEmpty {
				items.append(URLQueryItem(name: key, value: value))
			}
		}
		if !items.isEmpty { components.queryItems = items }
		guard let url = components.url else {
			throw APIError(statusCode: 0, message: "Invalid URL")
		}

		var request = URLRequest(url: url)
		request.httpMethod = method
		request.timeoutInterval = configuration.requestTimeout
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(Self.clientHeaderValue, forHTTPHeaderField: "X-Client")
		request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
		if let origin = configuration.siteAddress.authOriginHeader {
			request.setValue(origin, forHTTPHeaderField: "Origin")
		}
		if let token {
			request.setValue(token, forHTTPHeaderField: "X-Reservation-Token")
		}
		for (name, value) in headers {
			request.setValue(value, forHTTPHeaderField: name)
		}
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try JSONSerialization.data(withJSONObject: body)
		}
		return request
	}

	private func get<T: Decodable>(
		_ path: String,
		query: [String: String?] = [:],
		token: String? = nil
	) async throws -> T {
		try await execute(method: "GET", path: path, query: query, body: nil, headers: [:], token: token)
	}

	private func post<T: Decodable>(
		_ path: String,
		body: [String: Any],
		headers: [String: String] = [:],
		token: String? = nil
	) async throws -> T {
		try await execute(method: "POST", path: path, query: [:], body: body, headers: headers, token: token)
	}

	private func execute<T: Decodable>(
		method: String,
		path: String,
		query: [String: String?],
		body: [String: Any]?,
		headers: [String: String],
		token: String?
	) async throws -> T {
		let data: Data = try await session.authorized { accessToken in
			let request = try self.makeRequest(
				method: method,
				path: path,
				query: query,
				body: body,
				headers: headers,
				token: token,
				accessToken: accessToken
			)
			return try await self.perform(request)
		}
		do {
			return try JSONDecoder().decode(T.self, from: data)
		} catch {
			throw APIError(statusCode: 200, message: "Unexpected response from the server")
		}
	}

	/// Maps the transport outcome: `401` becomes `APIError.unauthorized` so the
	/// session refreshes once; any other non-2xx keeps the server's stable code;
	/// a transport failure is `APIError` status `0` (offline, timeout).
	private func perform(_ request: URLRequest) async throws -> Data {
		do {
			let (data, response) = try await transport.send(request)
			if (200..<300).contains(response.statusCode) { return data }
			if response.statusCode == 401 { throw APIError.unauthorized }
			throw ReservationAPIError.from(statusCode: response.statusCode, data: data)
		} catch let error as APIError {
			throw error
		} catch let error as ReservationAPIError {
			throw error
		} catch {
			throw APIError(statusCode: 0, message: "Network error")
		}
	}
}
