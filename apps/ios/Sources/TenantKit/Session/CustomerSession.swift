import Foundation

/// Owns the customer's tenant-api session for one org.
///
/// Mirrors the browser behaviour in `apps/sites/src/lib/client-auth.ts`:
/// a short-lived access token (15 min) plus a rotating refresh token, with a
/// single transparent retry when tenant-api answers `401`.
public actor CustomerSession {
	private let client: TenantAPIClient
	private let storage: TokenStorage
	private var currentTokens: AuthTokens?
	/// One in-flight refresh shared by every caller: tenant-api rotates refresh
	/// tokens and revokes the family when a token is replayed, so two parallel
	/// refreshes would sign the customer out.
	private var refreshTask: (id: Int, task: Task<AuthTokens, Error>)?
	private var nextRefreshID = 0
	/// Bumped on sign-out so a refresh that was already in flight cannot write
	/// rotated tokens back into a session the customer just ended.
	private var sessionGeneration = 0

	public init(client: TenantAPIClient, storage: TokenStorage = TokenStorageFactory.makeDefault()) {
		self.client = client
		self.storage = storage
		self.currentTokens = storage.load()
	}

	public var tokens: AuthTokens? { currentTokens }

	public var isSignedIn: Bool { currentTokens != nil }

	public var customerName: String? { currentTokens?.name }

	public var customerFirstName: String? { currentTokens?.firstName }

	/// Loads a previously stored session (call on launch).
	@discardableResult
	public func restore() -> AuthTokens? {
		if currentTokens == nil { currentTokens = storage.load() }
		return currentTokens
	}

	// MARK: - Auth flows

	public func sendCode(phone: String) async throws {
		let normalized = PhoneNumber.normalize(phone)
		guard PhoneNumber.isValid(normalized) else {
			throw APIError(statusCode: 400, message: "Enter a valid phone number.")
		}
		try await client.sendCode(phone: normalized)
	}

	@discardableResult
	public func verify(phone: String, code: String) async throws -> VerifyResult {
		let result = try await client.verify(
			phone: PhoneNumber.normalize(phone),
			code: code.trimmingCharacters(in: .whitespacesAndNewlines)
		)
		if let accessToken = result.accessToken {
			store(AuthTokens(accessToken: accessToken, refreshToken: result.refreshToken))
		}
		return result
	}

	public func signOut() async {
		sessionGeneration += 1
		refreshTask?.task.cancel()
		refreshTask = nil

		let refreshToken = currentTokens?.refreshToken
		let orgId = currentTokens?.orgId
		clearTokens()
		await client.logout(refreshToken: refreshToken, orgId: orgId)
	}

	// MARK: - Authorized calls

	/// Runs an authenticated request, refreshing the access token once on `401`.
	public func authorized<T>(_ operation: @Sendable (String) async throws -> T) async throws -> T {
		guard let accessToken = currentTokens?.accessToken else {
			throw APIError.unauthorized
		}
		do {
			return try await operation(accessToken)
		} catch let error as APIError where error.isUnauthorized {
			// `refresh()` clears the session only for a terminal auth failure and
			// rethrows transient errors, which must not sign the customer out.
			let refreshed = try await refresh()
			return try await operation(refreshed.accessToken)
		}
	}

	public func profile() async throws -> CustomerProfile {
		try await authorized { [client] token in
			try await client.fetchProfile(accessToken: token)
		}
	}

	public func updateProfile(name: String, email: String?) async throws -> CustomerProfile {
		let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmedName.count >= 2 else {
			throw APIError(statusCode: 400, message: "Name is required.")
		}
		let trimmedEmail = email?.trimmingCharacters(in: .whitespacesAndNewlines)
		let next = try await authorized { [client] token in
			try await client.updateProfile(
				name: trimmedName,
				email: trimmedEmail,
				accessToken: token
			)
		}
		// `/auth/profile` rotates the refresh token; keep the current one if the
		// response omits it so the session can still be refreshed.
		store(
			AuthTokens(
				accessToken: next.accessToken,
				refreshToken: next.refreshToken ?? currentTokens?.refreshToken
			)
		)
		return try await profile()
	}

	// MARK: - Refresh

	@discardableResult
	public func refresh() async throws -> AuthTokens {
		if let refreshTask {
			return try await refreshTask.task.value
		}

		nextRefreshID += 1
		let refreshID = nextRefreshID
		let generation = sessionGeneration
		let task = Task<AuthTokens, Error> { [client] in
			try await CustomerSession.performRefresh(
				client: client,
				session: self,
				generation: generation
			)
		}
		refreshTask = (id: refreshID, task: task)

		do {
			let tokens = try await task.value
			clearRefreshTask(id: refreshID)
			return tokens
		} catch {
			clearRefreshTask(id: refreshID)
			throw error
		}
	}

	/// Only clears the slot when it still holds this task: sign-out may already
	/// have installed a newer refresh, which must not be discarded.
	private func clearRefreshTask(id: Int) {
		if refreshTask?.id == id { refreshTask = nil }
	}

	private static func performRefresh(
		client: TenantAPIClient,
		session: CustomerSession,
		generation: Int
	) async throws -> AuthTokens {
		guard
			let tokens = await session.currentTokens,
			let refreshToken = tokens.refreshToken,
			let orgId = tokens.orgId
		else {
			throw APIError.unauthorized
		}

		do {
			let refreshed = try await client.refresh(refreshToken: refreshToken, orgId: orgId)
			// tenant-api rotates refresh tokens; keep the newest one.
			let merged = AuthTokens(
				accessToken: refreshed.accessToken,
				refreshToken: refreshed.refreshToken ?? refreshToken
			)
			guard await session.store(merged, generation: generation) else {
				// The customer signed out while this refresh was in flight.
				throw APIError.unauthorized
			}
			return merged
		} catch let error as APIError where error.isUnauthorized || error.statusCode == 403 {
			// The refresh token is dead (expired, revoked, or replayed).
			await session.clearTokens(generation: generation)
			throw error
		} catch {
			// Timeout, offline, 5xx: the session may still be valid, so keep it.
			throw error
		}
	}

	/// Returns `false` when the session ended (or was replaced) while the caller
	/// was in flight, in which case the tokens must not be adopted.
	@discardableResult
	private func store(_ tokens: AuthTokens, generation: Int? = nil) -> Bool {
		if let generation, generation != sessionGeneration { return false }
		currentTokens = tokens
		// A Keychain failure only costs the session on next launch; the customer
		// stays signed in for this run rather than being dropped mid-flow.
		storage.save(tokens)
		return true
	}

	private func clearTokens(generation: Int? = nil) {
		if let generation, generation != sessionGeneration { return }
		currentTokens = nil
		storage.save(nil)
	}
}
