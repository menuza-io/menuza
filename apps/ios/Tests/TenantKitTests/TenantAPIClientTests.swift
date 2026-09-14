import XCTest

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@testable import TenantKit

final class TenantAPIClientTests: XCTestCase {
	func testFetchOrganizationUsesSlugBindingAndDecodesBranding() async throws {
		let transport = StubTransport(responses: [
			StubTransport.json([
				"id": "org_1",
				"name": "Acme Coffee",
				"slug": "acme",
				"dataRegion": "us",
				"locales": ["en", "ar"],
				"defaultLocale": "en",
				"siteIcon": ["original": "/resources/images?objectKey=org%2Facme%2Ficon.png"],
				"theme": [
					"baseColor": "neutral",
					"theme": "amber",
					"radius": "large",
					"mode": "system",
					"headingFont": "space-grotesk",
					"bodyFont": "inter",
					"css": "html { --primary: oklch(0.205 0 0); }",
				],
				"announcements": [
					[
						"id": "ann_1",
						"content": "Free delivery this week",
						"type": "info",
						"linkUrl": "/shop",
						"linkLabel": "Shop",
						"linkNewTab": false,
					],
				],
			]),
		])
		let client = TenantAPIClient(configuration: makeConfiguration(), transport: transport)

		let organization = try await client.fetchOrganization(locale: "ar")

		XCTAssertEqual(organization.name, "Acme Coffee")
		XCTAssertEqual(organization.resolvedDataRegion, "us")
		XCTAssertEqual(organization.resolvedLocales, ["en", "ar"])
		XCTAssertEqual(organization.theme?.theme, "amber")
		XCTAssertEqual(organization.announcements?.first?.content, "Free delivery this week")

		let iconURL = try XCTUnwrap(
			organization.iconURL(baseURL: URL(string: "https://app.epic-startup.com")!)
		)
		XCTAssertEqual(
			iconURL.absoluteString,
			"https://app.epic-startup.com/resources/images?objectKey=org%2Facme%2Ficon.png"
		)

		let url = try XCTUnwrap(transport.lastRequest?.url)
		XCTAssertEqual(url.path, "/resources/sites")
		let query = url.query ?? ""
		XCTAssertTrue(query.contains("slug=acme"))
		XCTAssertTrue(query.contains("lng=ar"))
	}

	func testFetchOrganizationUsesCustomDomainBinding() async throws {
		let transport = StubTransport(responses: [
			StubTransport.json(["id": "org_2", "name": "Custom", "slug": "custom"]),
		])
		let client = TenantAPIClient(
			configuration: makeConfiguration(slug: nil, host: "www.acme.com"),
			transport: transport
		)

		_ = try await client.fetchOrganization()

		let query = try XCTUnwrap(transport.lastRequest?.url.query)
		XCTAssertTrue(query.contains("host=www.acme.com"))
		XCTAssertFalse(query.contains("slug="))
	}

	func testUnboundClientRefusesToCallSiteAPIs() async throws {
		let transport = StubTransport()
		let client = TenantAPIClient(
			configuration: makeConfiguration(slug: nil, host: nil),
			transport: transport
		)

		do {
			_ = try await client.fetchOrganization()
			XCTFail("Expected a binding error")
		} catch let error as APIError {
			XCTAssertEqual(error.message, APIError.notBoundToTenant.message)
		} catch {
			XCTFail("Unexpected error: \(error)")
		}
	}

	func testSendCodeBindsToTenantWithOriginHeader() async throws {
		let transport = StubTransport(responses: [StubTransport.json(["success": true])])
		let client = TenantAPIClient(
			configuration: makeConfiguration(origin: "https://acme.epic-startup.com"),
			transport: transport
		)

		try await client.sendCode(phone: "+15550001111")

		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.url.absoluteString, "https://tenant-us.epic-startup.com/auth/send-code")
		XCTAssertEqual(recorded.body["slug"] as? String, "acme")
		XCTAssertEqual(recorded.body["phone"] as? String, "+15550001111")
		XCTAssertEqual(
			recorded.request.value(forHTTPHeaderField: "Origin"),
			"https://acme.epic-startup.com"
		)
	}

	func testSendCodeOmitsOriginForLocalDevelopment() async throws {
		let transport = StubTransport(responses: [StubTransport.json(["success": true])])
		let client = TenantAPIClient(
			configuration: makeConfiguration(origin: "http://acme.epic-startup.test:3010"),
			transport: transport
		)

		try await client.sendCode(phone: "+15550001111")

		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertNil(recorded.request.value(forHTTPHeaderField: "Origin"))
		XCTAssertEqual(recorded.body["slug"] as? String, "acme")
	}

	func testKSAOrgsUseTheKSANode() async throws {
		let transport = StubTransport(responses: [StubTransport.json(["success": true])])
		let client = TenantAPIClient(
			configuration: makeConfiguration(origin: "https://acme.epic-startup.com", region: "ksa"),
			transport: transport
		)

		try await client.sendCode(phone: "+966500000000")

		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.url.host, "tenant-ksa.epic-startup.com")
	}

	func testVerifySurfacesServerErrorDescription() async throws {
		let transport = StubTransport(rawResponses: [
			(
				status: 429,
				data: Data(
					#"{"error":"rate_limit_exceeded","error_description":"Too many verification attempts for this phone number."}"#
						.utf8
				)
			),
		])
		let client = TenantAPIClient(configuration: makeConfiguration(), transport: transport)

		do {
			_ = try await client.verify(phone: "+15550001111", code: "123456")
			XCTFail("Expected a rate limit error")
		} catch let error as APIError {
			XCTAssertEqual(error.statusCode, 429)
			XCTAssertTrue(error.isRateLimited)
			XCTAssertEqual(error.message, "Too many verification attempts for this phone number.")
		}
	}

	func testVerifyRejectsResponsesWithoutAccessToken() async throws {
		let transport = StubTransport(responses: [StubTransport.json(["success": false, "error": "Invalid or expired code"])])
		let client = TenantAPIClient(configuration: makeConfiguration(), transport: transport)

		do {
			_ = try await client.verify(phone: "+15550001111", code: "000000")
			XCTFail("Expected an error")
		} catch let error as APIError {
			XCTAssertEqual(error.message, "Invalid or expired code")
		}
	}

	func testFetchProfileSendsBearerToken() async throws {
		let transport = StubTransport(responses: [
			StubTransport.json([
				"customer": [
					"id": "cust_1",
					"name": "Ada Lovelace",
					"email": "ada@example.com",
					"phone": "+15550001111",
					"needsName": false,
				],
			]),
		])
		let client = TenantAPIClient(configuration: makeConfiguration(), transport: transport)

		let profile = try await client.fetchProfile(accessToken: "token-123")

		XCTAssertEqual(profile.name, "Ada Lovelace")
		XCTAssertEqual(profile.needsName, false)
		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.url.absoluteString, "https://tenant-us.epic-startup.com/auth/me")
		XCTAssertEqual(recorded.request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
	}

	func testUpdateProfilePostsNameAndEmail() async throws {
		let transport = StubTransport(responses: [
			StubTransport.json(["success": true, "accessToken": makeAccessToken(), "refreshToken": "refresh-2"]),
		])
		let client = TenantAPIClient(configuration: makeConfiguration(), transport: transport)

		let tokens = try await client.updateProfile(
			name: "Ada Byron",
			email: "ada@example.com",
			accessToken: "token-123"
		)

		XCTAssertEqual(tokens.refreshToken, "refresh-2")
		let recorded = try XCTUnwrap(transport.lastRequest)
		XCTAssertEqual(recorded.url.absoluteString, "https://tenant-us.epic-startup.com/auth/profile")
		XCTAssertEqual(recorded.body["name"] as? String, "Ada Byron")
		XCTAssertEqual(recorded.body["email"] as? String, "ada@example.com")
	}

	func testUnexpectedPayloadsBecomeAPIErrors() async throws {
		let transport = StubTransport(rawResponses: [(status: 200, data: Data(#"{"unexpected":true}"#.utf8))])
		let client = TenantAPIClient(configuration: makeConfiguration(), transport: transport)

		do {
			_ = try await client.fetchOrganization()
			XCTFail("Expected a decoding error")
		} catch let error as APIError {
			XCTAssertEqual(error.statusCode, 200)
			XCTAssertTrue(error.message.contains("Unexpected response"))
		}
	}

	func testTransportFailuresBecomeTransportAPIErrors() async throws {
		let client = TenantAPIClient(configuration: makeConfiguration(), transport: FailingTransport())

		do {
			_ = try await client.fetchOrganization()
			XCTFail("Expected a transport error")
		} catch let error as APIError {
			XCTAssertTrue(error.isTransportFailure)
			XCTAssertFalse(error.message.isEmpty)
		}
	}
}
