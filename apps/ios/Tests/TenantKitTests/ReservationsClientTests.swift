import XCTest

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@testable import TenantKit

final class ReservationsClientTests: XCTestCase {
	private func makeClient(
		transport: StubTransport,
		configuration: TenantConfiguration = makeConfiguration()
	) -> ReservationsClient {
		ReservationsClient(
			configuration: configuration,
			session: makeSignedInSession(configuration: configuration, transport: transport),
			transport: transport
		)
	}

	private func fixtureTransport(_ names: String...) throws -> StubTransport {
		StubTransport(
			rawResponses: try names.map { (status: 200, data: try ReservationFixtures.data($0)) }
		)
	}

	private let details = ReservationGuestDetails(
		firstName: " Ada ",
		lastName: "Lovelace",
		phone: "+14155553001",
		email: "ada@example.com",
		occasionTagId: "tag_pub_birthday",
		requests: "Window seat",
		dietary: "",
		smsOptIn: true,
		locale: "en",
		policyTermsVersion: "2"
	)

	// MARK: Request shape

	func testAvailabilitySendsBindingClientHeaderAndBearerWithoutTurnstile() async throws {
		let transport = try fixtureTransport("availability")
		let client = makeClient(transport: transport)

		let availability = try await client.availability(
			locationId: "loc_pub_main",
			date: "2030-06-24",
			partySize: 2,
			localMin: 1140
		)

		XCTAssertEqual(availability.status, "available")
		let request = try XCTUnwrap(transport.lastRequest?.request)
		XCTAssertEqual(request.httpMethod, "GET")
		XCTAssertEqual(request.url?.path, "/reservations/availability")
		let query = try XCTUnwrap(request.url?.query)
		XCTAssertTrue(query.contains("slug=acme"))
		XCTAssertTrue(query.contains("locationId=loc_pub_main"))
		XCTAssertTrue(query.contains("date=2030-06-24"))
		XCTAssertTrue(query.contains("partySize=2"))
		XCTAssertTrue(query.contains("localMin=1140"))
		XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client"), "ios")
		XCTAssertTrue(request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
		XCTAssertNil(request.value(forHTTPHeaderField: "X-Turnstile-Token"))
		XCTAssertEqual(request.url?.host, "tenant-us.epic-startup.com")
	}

	func testSendsTheSiteOriginForHttpsSites() async throws {
		let transport = try fixtureTransport("config")
		let client = makeClient(
			transport: transport,
			configuration: makeConfiguration(origin: "https://acme.epic-startup.com")
		)

		_ = try await client.config()

		let request = try XCTUnwrap(transport.lastRequest?.request)
		XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://acme.epic-startup.com")
	}

	func testLocalSitesSendNoOriginAndRelyOnTheSlugBinding() async throws {
		let transport = try fixtureTransport("config")
		let client = makeClient(
			transport: transport,
			configuration: makeConfiguration(origin: "http://acme.localhost:3008")
		)

		_ = try await client.config()

		let request = try XCTUnwrap(transport.lastRequest?.request)
		XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
		XCTAssertTrue(request.url?.query?.contains("slug=acme") == true)
	}

	func testKsaOrganizationsCallTheKsaNode() async throws {
		let transport = try fixtureTransport("config")
		let client = makeClient(transport: transport, configuration: makeConfiguration(region: "ksa"))

		_ = try await client.config()

		XCTAssertEqual(transport.lastRequest?.request.url?.host, "tenant-ksa.epic-startup.com")
	}

	func testHoldIsAPostWithTheSlotAndNoPhoneOrTurnstileField() async throws {
		let transport = try fixtureTransport("hold")
		let client = makeClient(transport: transport)

		let hold = try await client.createHold(
			locationId: "loc_pub_main",
			date: "2030-06-24",
			localMin: 1140,
			partySize: 2,
			serviceId: "svc_pub_dinner"
		)

		XCTAssertFalse(hold.holdToken.isEmpty)
		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.request.httpMethod, "POST")
		XCTAssertEqual(recorded.url.path, "/reservations/holds")
		XCTAssertEqual(recorded.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
		XCTAssertEqual(recorded.body["locationId"] as? String, "loc_pub_main")
		let slot = try XCTUnwrap(recorded.body["slot"] as? [String: Any])
		XCTAssertEqual(slot["date"] as? String, "2030-06-24")
		XCTAssertEqual(slot["localMin"] as? Int, 1140)
		XCTAssertEqual(slot["partySize"] as? Int, 2)
		XCTAssertEqual(slot["serviceId"] as? String, "svc_pub_dinner")
		XCTAssertNil(recorded.body["turnstileToken"])
		XCTAssertNil(recorded.body["phone"])
	}

	func testBookSendsTheIdempotencyKeyTheGuestBlockAndAnEmptyHoneypot() async throws {
		let transport = try fixtureTransport("booking")
		let client = makeClient(transport: transport)

		let booking = try await client.book(
			holdToken: "hold_secret_token_value",
			details: details,
			idempotencyKey: "native-key-0001"
		)

		XCTAssertEqual(booking.reservation.status, "booked")
		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.request.httpMethod, "POST")
		XCTAssertEqual(recorded.url.path, "/reservations")
		XCTAssertEqual(recorded.request.value(forHTTPHeaderField: "Idempotency-Key"), "native-key-0001")
		XCTAssertEqual(recorded.body["holdToken"] as? String, "hold_secret_token_value")
		XCTAssertEqual(recorded.body["website"] as? String, "")
		XCTAssertEqual(recorded.body["smsOptIn"] as? Bool, true)
		XCTAssertNil(recorded.body["turnstileToken"])
		let guest = try XCTUnwrap(recorded.body["guest"] as? [String: Any])
		XCTAssertEqual(guest["firstName"] as? String, "Ada")
		XCTAssertEqual(guest["phone"] as? String, "+14155553001")
		XCTAssertEqual(guest["email"] as? String, "ada@example.com")
		XCTAssertEqual(recorded.body["occasionTagId"] as? String, "tag_pub_birthday")
		XCTAssertEqual(recorded.body["requests"] as? String, "Window seat")
		XCTAssertNil(recorded.body["dietary"], "empty optional text is omitted")
		let accepted = try XCTUnwrap(recorded.body["policyAccepted"] as? [String: Any])
		XCTAssertEqual(accepted["termsVersion"] as? String, "2")
		// The hold token travels in the body, never in the URL.
		XCTAssertFalse(recorded.url.absoluteString.contains("hold_secret_token_value"))
	}

	func testRetryAfterANetworkErrorSendsTheSameIdempotencyKey() async throws {
		let failing = FailingTransport()
		let session = makeSignedInSession(transport: failing)
		let offline = ReservationsClient(
			configuration: makeConfiguration(),
			session: session,
			transport: failing
		)
		do {
			_ = try await offline.book(holdToken: "hold_token_abcdef", details: details, idempotencyKey: "key-retry-001")
			XCTFail("expected a transport failure")
		} catch let error as APIError {
			XCTAssertTrue(error.isTransportFailure)
		}

		let transport = try fixtureTransport("booking")
		let client = makeClient(transport: transport)
		_ = try await client.book(holdToken: "hold_token_abcdef", details: details, idempotencyKey: "key-retry-001")
		XCTAssertEqual(
			transport.lastRequest?.request.value(forHTTPHeaderField: "Idempotency-Key"),
			"key-retry-001"
		)
	}

	func testLargePartyRequestIsAPostWithTheSlotInsideTheBody() async throws {
		let transport = try fixtureTransport("request")
		let client = makeClient(transport: transport)

		let booking = try await client.requestLargeParty(
			locationId: "loc_pub_main",
			date: "2030-06-24",
			localMin: 1020,
			partySize: 8,
			details: details,
			idempotencyKey: "native-key-0002"
		)

		XCTAssertEqual(booking.reservation.status, "requested")
		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.url.path, "/reservations/requests")
		XCTAssertEqual(recorded.request.value(forHTTPHeaderField: "Idempotency-Key"), "native-key-0002")
		XCTAssertEqual(recorded.body["locationId"] as? String, "loc_pub_main")
		XCTAssertEqual((recorded.body["slot"] as? [String: Any])?["partySize"] as? Int, 8)
	}

	func testManageTokenTravelsInTheHeaderNeverTheUrl() async throws {
		let transport = try fixtureTransport("manage")
		let client = makeClient(transport: transport)

		_ = try await client.manage(token: "rsv_m_secret_manage_token")

		let request = try XCTUnwrap(transport.lastRequest?.request)
		XCTAssertEqual(request.httpMethod, "GET")
		XCTAssertEqual(request.url?.path, "/reservations/manage")
		XCTAssertEqual(request.value(forHTTPHeaderField: "X-Reservation-Token"), "rsv_m_secret_manage_token")
		XCTAssertFalse(request.url?.absoluteString.contains("rsv_m_secret_manage_token") == true)
	}

	func testPaymentStatusPollIsAGetWithTheTokenHeader() async throws {
		let transport = try fixtureTransport("payment-status-pending")
		let client = makeClient(transport: transport)

		let status = try await client.paymentStatus(token: "rsv_p_secret_payment_token")

		XCTAssertEqual(status.paymentStatus, "pending")
		let request = try XCTUnwrap(transport.lastRequest?.request)
		XCTAssertEqual(request.httpMethod, "GET")
		XCTAssertEqual(request.url?.path, "/reservations/manage/payment")
		XCTAssertEqual(request.value(forHTTPHeaderField: "X-Reservation-Token"), "rsv_p_secret_payment_token")
		XCTAssertNil(request.httpBody)
	}

	func testManageMutationsArePostsWithAnEmptyOrSmallBody() async throws {
		let transport = StubTransport(rawResponses: try (0..<4).map { _ in
			(status: 200, data: try ReservationFixtures.data("manage"))
		})
		let client = makeClient(transport: transport)

		_ = try await client.modify(token: "tok_manage_0001", date: "2030-06-25", localMin: 1170, partySize: 3)
		_ = try await client.cancel(token: "tok_manage_0001")
		_ = try await client.confirm(token: "tok_manage_0001")
		_ = try await client.runningLate(token: "tok_manage_0001", minutes: 15)

		let paths = transport.recorded.map(\.url.path)
		XCTAssertEqual(paths, [
			"/reservations/manage/modify",
			"/reservations/manage/cancel",
			"/reservations/manage/confirm",
			"/reservations/manage/running-late",
		])
		XCTAssertTrue(transport.recorded.allSatisfy { $0.request.httpMethod == "POST" })
		XCTAssertEqual(transport.recorded[0].body["localMin"] as? Int, 1170)
		XCTAssertEqual(transport.recorded[0].body["date"] as? String, "2030-06-25")
		XCTAssertEqual(transport.recorded[0].body["partySize"] as? Int, 3)
		XCTAssertEqual(transport.recorded[3].body["minutes"] as? Int, 15)
	}

	func testEveryCallIsGetOrPostWithClientHeaderBearerAndBinding() async throws {
		let transport = StubTransport(handler: { _ in (status: 200, body: [String: String]()) })
		let client = makeClient(transport: transport)
		let key = "native-key-9999"

		_ = try? await client.config(locale: "ar")
		_ = try? await client.availability(locationId: "l", date: "2030-06-24", partySize: 2)
		_ = try? await client.calendar(locationId: "l", partySize: 2, from: "2030-06-24", to: "2030-06-30")
		_ = try? await client.createHold(locationId: "l", date: "2030-06-24", localMin: 1140, partySize: 2)
		_ = try? await client.releaseHold(holdToken: "hold_token_0001")
		_ = try? await client.book(holdToken: "hold_token_0001", details: details, idempotencyKey: key)
		_ = try? await client.requestLargeParty(
			locationId: "l", date: "2030-06-24", localMin: 1140, partySize: 9, details: details, idempotencyKey: key
		)
		_ = try? await client.mine()
		_ = try? await client.manage(token: "tok_manage_0001")
		_ = try? await client.manageAvailability(token: "tok_manage_0001", date: "2030-06-25")
		_ = try? await client.modify(token: "tok_manage_0001", localMin: 1140)
		_ = try? await client.cancel(token: "tok_manage_0001")
		_ = try? await client.confirm(token: "tok_manage_0001")
		_ = try? await client.runningLate(token: "tok_manage_0001", minutes: 10)
		_ = try? await client.paymentStatus(token: "tok_pay_0001")
		_ = try? await client.joinWaitlist(
			locationId: "l", name: "Ada", partySize: 2, phone: "+14155553001", smsOptIn: false, locale: "en",
			idempotencyKey: key
		)
		_ = try? await client.waitlistStatus(token: "tok_wait_0001")
		_ = try? await client.leaveWaitlist(token: "tok_wait_0001")
		_ = try? await client.waitlistOnMyWay(token: "tok_wait_0001")

		XCTAssertEqual(transport.recorded.count, 19)
		for recorded in transport.recorded {
			let request = recorded.request
			XCTAssertTrue(["GET", "POST"].contains(request.httpMethod ?? ""), recorded.url.path)
			XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client"), "ios", recorded.url.path)
			XCTAssertTrue(
				request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true,
				recorded.url.path
			)
			XCTAssertTrue(recorded.url.query?.contains("slug=acme") == true, recorded.url.path)
			XCTAssertNil(request.value(forHTTPHeaderField: "X-Turnstile-Token"))
			let url = recorded.url.absoluteString
			for secret in ["tok_manage_0001", "tok_pay_0001", "tok_wait_0001", "hold_token_0001"] {
				XCTAssertFalse(url.contains(secret), "\(secret) leaked into \(recorded.url.path)")
			}
		}
		// Mutations are POST, reads are GET.
		let mutating = ["holds", "release", "requests", "modify", "cancel", "confirm", "running-late", "join", "leave", "on-my-way"]
		for recorded in transport.recorded where mutating.contains(where: { recorded.url.path.hasSuffix($0) }) {
			XCTAssertEqual(recorded.request.httpMethod, "POST", recorded.url.path)
		}
		XCTAssertEqual(transport.recorded.filter { $0.request.httpMethod == "GET" }.count, 8)
	}

	// MARK: Errors and refresh

	func testSlotUnavailableKeepsTheAlternativesFromTheAnswer() async throws {
		let transport = StubTransport(rawResponses: [
			(status: 409, data: try ReservationFixtures.data("error-slot-unavailable")),
		])
		let client = makeClient(transport: transport)

		do {
			_ = try await client.createHold(locationId: "l", date: "2030-06-24", localMin: 1080, partySize: 4)
			XCTFail("expected 409")
		} catch let error as ReservationAPIError {
			XCTAssertEqual(error.statusCode, 409)
			XCTAssertEqual(error.code, "slot_unavailable")
			XCTAssertEqual(error.alternatives?.sameDay.isEmpty, false)
			XCTAssertEqual(BookingFailure.map(error), .slotUnavailable(try XCTUnwrap(error.alternatives)))
		}
	}

	func testHoldExpiredAndRateLimitedMapToStableFailures() async throws {
		let transport = StubTransport(rawResponses: [
			(status: 410, data: try ReservationFixtures.data("error-hold-expired")),
			(status: 429, data: try ReservationFixtures.data("error-rate-limited")),
			(status: 400, data: try ReservationFixtures.data("error-policy-required")),
		])
		let client = makeClient(transport: transport)
		var failures: [BookingFailure] = []
		for _ in 0..<3 {
			do {
				_ = try await client.book(holdToken: "hold_token_0001", details: details, idempotencyKey: "native-key-0003")
			} catch {
				failures.append(BookingFailure.map(error))
			}
		}
		XCTAssertEqual(failures, [.holdExpired, .rateLimited(reason: "phone_active_limit"), .policyRequired])
	}

	func testAnExpiredAccessTokenRefreshesOnceAndTheCallIsRetried() async throws {
		let refreshed = makeAccessToken(name: "Ada Lovelace")
		let refreshBody = try JSONSerialization.data(withJSONObject: [
			"accessToken": refreshed,
			"refreshToken": "refresh-2",
		])
		let transport = StubTransport(rawResponses: [
			(status: 401, data: Data(#"{"error":"unauthorized"}"#.utf8)),
			(status: 200, data: refreshBody),
			(status: 200, data: try ReservationFixtures.data("config")),
		])
		let client = makeClient(transport: transport)

		let config = try await client.config()

		XCTAssertEqual(config.organization.name, "Acme Bistro")
		XCTAssertEqual(transport.recorded.map(\.url.path), [
			"/reservations/config", "/auth/refresh", "/reservations/config",
		])
		XCTAssertEqual(
			transport.recorded[2].request.value(forHTTPHeaderField: "Authorization"),
			"Bearer \(refreshed)"
		)
	}

	func testOfflineSurfacesAsATransportFailure() async throws {
		let session = makeSignedInSession(transport: FailingTransport())
		let client = ReservationsClient(
			configuration: makeConfiguration(),
			session: session,
			transport: FailingTransport()
		)
		do {
			_ = try await client.config()
			XCTFail("expected a failure")
		} catch {
			XCTAssertEqual(BookingFailure.map(error), .offline)
		}
	}

	func testSignedOutCallsFailLocallyWithoutHittingTheNetwork() async throws {
		let transport = StubTransport()
		let session = CustomerSession(
			client: TenantAPIClient(configuration: makeConfiguration(), transport: transport),
			storage: InMemoryTokenStorage()
		)
		let client = ReservationsClient(configuration: makeConfiguration(), session: session, transport: transport)
		do {
			_ = try await client.config()
			XCTFail("expected unauthorized")
		} catch {
			XCTAssertEqual(BookingFailure.map(error), .signInRequired)
		}
		XCTAssertTrue(transport.recorded.isEmpty)
	}
}
