import XCTest

@testable import TenantKit

final class CustomerSessionTests: XCTestCase {
	private func makeSession(
		transport: StubTransport,
		storage: TokenStorage
	) -> CustomerSession {
		CustomerSession(
			client: TenantAPIClient(configuration: makeConfiguration(), transport: transport),
			storage: storage
		)
	}

	func testRestoresStoredSession() async {
		let stored = AuthTokens(accessToken: makeAccessToken(name: "Ada Lovelace"), refreshToken: "refresh-1")
		let session = makeSession(
			transport: StubTransport(),
			storage: InMemoryTokenStorage(tokens: stored)
		)

		let restored = await session.restore()

		XCTAssertEqual(restored?.accessToken, stored.accessToken)
		let isSignedIn = await session.isSignedIn
		XCTAssertTrue(isSignedIn)
		let firstName = await session.customerFirstName
		XCTAssertEqual(firstName, "Ada")
	}

	func testVerifyStoresTokens() async throws {
		let storage = InMemoryTokenStorage()
		let transport = StubTransport(responses: [
			StubTransport.json([
				"success": true,
				"accessToken": makeAccessToken(),
				"refreshToken": "refresh-1",
				"needsName": false,
			]),
		])
		let session = makeSession(transport: transport, storage: storage)

		let result = try await session.verify(phone: "+1 (555) 000-1111", code: " 123456 ")

		XCTAssertEqual(result.needsName, false)
		XCTAssertNotNil(storage.load()?.accessToken)
		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.body["phone"] as? String, "+15550001111")
		XCTAssertEqual(recorded.body["code"] as? String, "123456")
	}

	func testRejectsShortPhoneNumbersLocally() async {
		let session = makeSession(transport: StubTransport(), storage: InMemoryTokenStorage())

		do {
			try await session.sendCode(phone: "123")
			XCTFail("Expected a validation error")
		} catch let error as APIError {
			XCTAssertEqual(error.message, "Enter a valid phone number.")
		} catch {
			XCTFail("Unexpected error: \(error)")
		}
	}

	func testAuthorizedRefreshesOnceAfterUnauthorized() async throws {
		let accessToken = makeAccessToken()
		let refreshedToken = makeAccessToken(name: "Ada Lovelace")
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: accessToken, refreshToken: "refresh-1")
		)
		let transport = StubTransport(rawResponses: [
			(status: 401, data: Data(#"{"error":"Invalid or expired token"}"#.utf8)),
			(status: 200, data: Data(#"{"success":true,"accessToken":"\#(refreshedToken)","refreshToken":"refresh-2"}"#.utf8)),
			(status: 200, data: Data(#"{"customer":{"id":"cust_1","name":"Ada Lovelace","needsName":false}}"#.utf8)),
		])
		let session = makeSession(transport: transport, storage: storage)

		let profile = try await session.profile()

		XCTAssertEqual(profile.name, "Ada Lovelace")
		let urls = transport.recorded.map(\.url.path)
		XCTAssertEqual(urls, ["/auth/me", "/auth/refresh", "/auth/me"])
		XCTAssertEqual(storage.load()?.refreshToken, "refresh-2")
	}

	func testAuthorizedSignsOutWhenRefreshFails() async throws {
		let accessToken = makeAccessToken()
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: accessToken, refreshToken: "refresh-1")
		)
		let transport = StubTransport(rawResponses: [
			(status: 401, data: Data(#"{"error":"Invalid or expired token"}"#.utf8)),
			(status: 401, data: Data(#"{"error":"Invalid refresh token"}"#.utf8)),
		])
		let session = makeSession(transport: transport, storage: storage)

		do {
			_ = try await session.profile()
			XCTFail("Expected the session to be cleared")
		} catch let error as APIError {
			XCTAssertTrue(error.isUnauthorized)
		} catch {
			XCTFail("Unexpected error: \(error)")
		}

		XCTAssertNil(storage.load())
		let stillSignedIn = await session.isSignedIn
		XCTAssertFalse(stillSignedIn)
	}

	func testUpdateProfileStoresRotatedTokens() async throws {
		let accessToken = makeAccessToken()
		let rotated = makeAccessToken(name: "Ada Byron")
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: accessToken, refreshToken: "refresh-1")
		)
		let transport = StubTransport(rawResponses: [
			(status: 200, data: Data(#"{"success":true,"accessToken":"\#(rotated)","refreshToken":"refresh-2"}"#.utf8)),
			(status: 200, data: Data(#"{"customer":{"id":"cust_1","name":"Ada Byron","needsName":false}}"#.utf8)),
		])
		let session = makeSession(transport: transport, storage: storage)

		let profile = try await session.updateProfile(name: " Ada Byron ", email: "ada@example.com")

		XCTAssertEqual(profile.name, "Ada Byron")
		XCTAssertEqual(storage.load()?.accessToken, rotated)
		let profileRequest = try XCTUnwrap(transport.recorded.first)
		XCTAssertEqual(profileRequest.body["name"] as? String, "Ada Byron")
		XCTAssertEqual(profileRequest.body["email"] as? String, "ada@example.com")
	}

	func testUpdateProfileValidatesName() async {
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
		let session = makeSession(transport: StubTransport(), storage: storage)

		do {
			_ = try await session.updateProfile(name: "A", email: nil)
			XCTFail("Expected a validation error")
		} catch let error as APIError {
			XCTAssertEqual(error.message, "Name is required.")
		} catch {
			XCTFail("Unexpected error: \(error)")
		}
	}

	func testSignOutRevokesRefreshTokenAndClearsStorage() async {
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
		let transport = StubTransport(responses: [StubTransport.json(["success": true])])
		let session = makeSession(transport: transport, storage: storage)

		await session.signOut()

		XCTAssertNil(storage.load())
		let recorded = try? XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded?.url.path, "/auth/logout")
		XCTAssertEqual(recorded?.body["refreshToken"] as? String, "refresh-1")
		XCTAssertEqual(recorded?.body["orgId"] as? String, "org_1")
	}

	func testConcurrentUnauthorizedCallsShareOneRefresh() async throws {
		let refreshed = makeAccessToken(name: "Ada Byron")
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
		let refreshCalls = Counter()
		// Path-keyed replies so the assertions hold whatever order the two
		// callers reach the transport in: profile requests fail until a refresh
		// has happened, which must occur exactly once.
		let transport = StubTransport(handler: { request in
			switch request.url?.path {
			case "/auth/refresh":
				_ = refreshCalls.increment()
				return (200, ["success": true, "accessToken": refreshed, "refreshToken": "refresh-2"])
			case "/auth/me":
				if refreshCalls.count == 0 {
					return (401, ["error": "Invalid or expired token"])
				}
				return (200, ["customer": ["id": "cust_1", "name": "Ada Lovelace"]])
			default:
				return (404, ["error": "unexpected \(request.url?.path ?? "")"])
			}
		})
		let session = makeSession(transport: transport, storage: storage)

		async let first = session.profile()
		async let second = session.profile()
		_ = try await (first, second)

		XCTAssertEqual(
			refreshCalls.count,
			1,
			"refresh tokens rotate; parallel refreshes would revoke the session"
		)
		XCTAssertEqual(storage.load()?.refreshToken, "refresh-2")
	}

	func testStaleUnauthorizedReusesAnotherCallersRefresh() async throws {
		let stale = makeAccessToken()
		let rotated = makeAccessToken(name: "Ada Byron")
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: stale, refreshToken: "refresh-1")
		)
		let refreshCalls = Counter()
		let staleRequests = Counter()
		let transport = StubTransport(delayedHandler: { request in
			switch request.url?.path {
			case "/auth/refresh":
				_ = refreshCalls.increment()
				return (200, ["success": true, "accessToken": rotated, "refreshToken": "refresh-2"], 0)
			case "/auth/me":
				guard request.value(forHTTPHeaderField: "Authorization") == "Bearer \(stale)" else {
					return (200, ["customer": ["id": "cust_1", "name": "Ada Byron"]], 0)
				}
				// This caller's 401 only lands after the refresh below finished.
				_ = staleRequests.increment()
				return (401, ["error": "Invalid or expired token"], 150)
			default:
				return (404, ["error": "unexpected \(request.url?.path ?? "")"], 0)
			}
		})
		let session = makeSession(transport: transport, storage: storage)

		async let staleCall = session.profile()
		for _ in 0..<2_000 where staleRequests.count == 0 {
			await Task.yield()
		}
		XCTAssertEqual(staleRequests.count, 1, "the stale request should reach the transport")

		// Another caller refreshes and rotates the tokens while that request is
		// still in flight, so its 401 is answered by a token that is already
		// stale — refreshing again would rotate the token a second time.
		let refreshed = try await session.refresh()
		XCTAssertEqual(refreshed.accessToken, rotated)

		let profile = try await staleCall
		XCTAssertEqual(profile.name, "Ada Byron")
		XCTAssertEqual(
			refreshCalls.count,
			1,
			"a 401 that predates another caller's refresh must retry with the rotated token"
		)
		XCTAssertEqual(storage.load()?.refreshToken, "refresh-2")
	}

	func testUpdateProfileKeepsRefreshTokenWhenResponseOmitsIt() async throws {
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
		let rotated = makeAccessToken(name: "Ada Byron")
		let transport = StubTransport(rawResponses: [
			(status: 200, data: Data(#"{"success":true,"accessToken":"\#(rotated)"}"#.utf8)),
			(status: 200, data: Data(#"{"customer":{"id":"cust_1","name":"Ada Byron"}}"#.utf8)),
		])
		let session = makeSession(transport: transport, storage: storage)

		_ = try await session.updateProfile(name: "Ada Byron", email: nil)

		XCTAssertEqual(storage.load()?.accessToken, rotated)
		XCTAssertEqual(storage.load()?.refreshToken, "refresh-1")
	}

	func testSignOutDiscardsAnInFlightRefresh() async throws {
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
		let rotated = makeAccessToken(name: "Ada Lovelace")
		let transport = StubTransport(delayedResponses: [
			(status: 401, data: Data(#"{"error":"Invalid or expired token"}"#.utf8), delayMs: 0),
			// Delayed so sign-out is guaranteed to land while this is in flight.
			(status: 200, data: Data(#"{"success":true,"accessToken":"\#(rotated)","refreshToken":"refresh-2"}"#.utf8), delayMs: 200),
			(status: 200, data: Data(#"{"success":true}"#.utf8), delayMs: 0),
		])
		let session = makeSession(transport: transport, storage: storage)

		async let profile: CustomerProfile? = try? await session.profile()
		try await Task.sleep(nanoseconds: 60_000_000) // let the 401 land and the refresh start
		await session.signOut()
		_ = await profile

		XCTAssertNil(storage.load(), "a refresh that finished after sign-out must not restore the session")
		let isSignedIn = await session.isSignedIn
		XCTAssertFalse(isSignedIn)
	}

	func testTransientRefreshFailureKeepsTheSession() async throws {
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
		let transport = StubTransport(rawResponses: [
			(status: 401, data: Data(#"{"error":"Invalid or expired token"}"#.utf8)),
			(status: 500, data: Data(#"{"error":"Internal Server Error"}"#.utf8)),
		])
		let session = makeSession(transport: transport, storage: storage)

		do {
			_ = try await session.profile()
			XCTFail("Expected the server error to surface")
		} catch let error as APIError {
			XCTAssertEqual(error.statusCode, 500)
		} catch {
			XCTFail("Unexpected error: \(error)")
		}

		XCTAssertNotNil(storage.load(), "a 5xx must not sign the customer out")
		XCTAssertEqual(storage.load()?.refreshToken, "refresh-1")
	}

	func testUpdateProfileOmitsEmailWhenNil() async throws {
		let storage = InMemoryTokenStorage(
			tokens: AuthTokens(accessToken: makeAccessToken(), refreshToken: "refresh-1")
		)
		let transport = StubTransport(rawResponses: [
			(status: 200, data: Data(#"{"success":true,"accessToken":"\#(makeAccessToken(name: "Ada"))"}"#.utf8)),
			(status: 200, data: Data(#"{"customer":{"id":"cust_1","name":"Ada","email":"kept@example.com"}}"#.utf8)),
		])
		let session = makeSession(transport: transport, storage: storage)

		_ = try await session.updateProfile(name: "Ada", email: nil)

		let request = try XCTUnwrap(transport.recorded.first)
		XCTAssertNil(request.body["email"], "nil must omit the field so a stored email is not cleared")
		XCTAssertEqual(request.body["name"] as? String, "Ada")
	}

	func testSignedOutSessionRefusesAuthorizedCalls() async {
		let session = makeSession(transport: StubTransport(), storage: InMemoryTokenStorage())

		do {
			_ = try await session.profile()
			XCTFail("Expected an unauthorized error")
		} catch let error as APIError {
			XCTAssertTrue(error.isUnauthorized)
		} catch {
			XCTFail("Unexpected error: \(error)")
		}
	}
}
