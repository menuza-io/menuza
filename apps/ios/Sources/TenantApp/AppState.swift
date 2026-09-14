import Foundation
import SwiftUI
import TenantKit

/// Persisted, non-sensitive app preferences (the site this app is connected to
/// and the customer's language choice). Tokens never live here — they are in the
/// Keychain via `CustomerSession`.
///
/// A reference type so `AppState` can mutate it without being `var` itself.
final class AppPreferences {
	private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	var siteAddress: SiteAddress? {
		get {
			let slug = defaults.string(forKey: "epic.siteSlug") ?? ""
			let host = defaults.string(forKey: "epic.siteHost") ?? ""
			let origin = defaults.string(forKey: "epic.siteOrigin") ?? ""
			guard !slug.isEmpty || !host.isEmpty else { return nil }
			return SiteAddress(
				slug: slug.isEmpty ? nil : slug,
				host: host.isEmpty ? nil : host,
				origin: URL(string: origin)
			)
		}
		set {
			defaults.set(newValue?.slug ?? "", forKey: "epic.siteSlug")
			defaults.set(newValue?.host ?? "", forKey: "epic.siteHost")
			defaults.set(newValue?.origin?.absoluteString ?? "", forKey: "epic.siteOrigin")
		}
	}

	var languageOverride: String? {
		get {
			let value = defaults.string(forKey: "epic.language") ?? ""
			return value.isEmpty ? nil : value
		}
		set { defaults.set(newValue ?? "", forKey: "epic.language") }
	}
}

/// The app's single source of truth: tenant branding, the customer session, and
/// the profile shown behind login.
@MainActor
final class AppState: ObservableObject {
	enum Phase: Equatable {
		case loading
		/// No tenant bound yet — the customer connects their site.
		case needsSite
		case ready
		case failed(String)
	}

	@Published private(set) var phase: Phase = .loading
	@Published private(set) var organization: PublicOrganization?
	@Published private(set) var theme: SiteTheme = .fallback
	@Published private(set) var profile: CustomerProfile?
	@Published private(set) var isSignedIn = false
	@Published private(set) var needsName = false
	@Published private(set) var isBusy = false
	@Published private(set) var isSavingProfile = false
	@Published private(set) var didSaveProfile = false
	@Published private(set) var errorMessage: String?
	@Published var pendingPhone: String?

	private(set) var configuration: TenantConfiguration
	private var client: TenantAPIClient
	private var session: CustomerSession?
	/// Bumped whenever the sign-in attempt is abandoned, so a late OTP response
	/// cannot sign the customer in after they backed out.
	private var authAttempt = 0
	private let preferences: AppPreferences

	init(
		configuration: TenantConfiguration = .from(infoDictionary: Bundle.main.infoDictionary),
		preferences: AppPreferences = AppPreferences()
	) {
		self.configuration = configuration
		self.preferences = preferences

		// A white-label build is bound to one tenant at build time; that binding
		// wins over anything a customer typed into an earlier un-branded install,
		// so the app never asks (or re-points) in the shipping case.
		let buildAddress = configuration.siteAddress
		self.configuration.siteAddress = SiteAddress.resolve(
			build: buildAddress,
			stored: preferences.siteAddress
		)
		if buildAddress.isBound {
			preferences.siteAddress = nil
		}

		self.client = TenantAPIClient(configuration: self.configuration)
	}

	// MARK: - Branding

	var siteName: String { organization?.name ?? "Tenant" }

	var iconURL: URL? { organization?.iconURL(baseURL: configuration.appBaseURL) }

	var announcements: [PublicSiteAnnouncement] { organization?.announcements ?? [] }

	/// UI language: customer override → device language → org language → English.
	var language: AppLanguage {
		AppLanguage.resolve(
			organization: organization,
			deviceLanguages: Locale.preferredLanguages,
			appLocales: AppLocalizations.available,
			override: preferences.languageOverride
		)
	}

	var languageOverride: String? {
		get { preferences.languageOverride }
		set {
			preferences.languageOverride = newValue
			objectWillChange.send()
		}
	}

	var availableLanguages: [String] { AppLocalizations.available }

	// MARK: - Lifecycle

	func start() async {
		guard configuration.isBoundToTenant else {
			phase = .needsSite
			return
		}
		await loadSite()
	}

	/// Connects the app to a tenant the customer typed in.
	///
	/// The binding is only persisted once the tenant's payload resolves, so a
	/// typo cannot leave the app pointed at a site that does not exist.
	func connect(to input: String) async {
		guard let address = SiteAddress.parse(input, brandDomain: configuration.brandDomain) else {
			errorMessage = language.string("connect.error")
			return
		}
		await loadSite(bindingTo: address)
	}

	func retry() async {
		guard configuration.isBoundToTenant else {
			phase = .needsSite
			return
		}
		await loadSite()
	}

	private func loadSite(bindingTo address: SiteAddress? = nil) async {
		let previousAddress = configuration.siteAddress
		if let address {
			// The client captures the configuration, so rebuild it for the new binding.
			configuration.siteAddress = address
			client = TenantAPIClient(configuration: configuration)
		}

		phase = .loading
		errorMessage = nil
		do {
			let organization = try await client.fetchOrganization()
			if let address {
				preferences.siteAddress = address
			}
			self.organization = organization
			self.theme = SiteTheme(theme: organization.theme)
			configureSession(for: organization)
			phase = .ready
		} catch {
			if address != nil {
				// Roll back for any failure (decoding errors included) so a failed
				// attempt cannot strand the app on a binding that does not resolve.
				configuration.siteAddress = previousAddress
				client = TenantAPIClient(configuration: configuration)
				phase = previousAddress.isBound ? .failed(message(for: error)) : .needsSite
			} else {
				phase = .failed(message(for: error))
			}
		}
	}

	/// Rebuilds the API client for the org's data region and restores any session.
	private func configureSession(for organization: PublicOrganization) {
		configuration.dataRegion = organization.resolvedDataRegion
		let client = TenantAPIClient(configuration: configuration)
		let session = CustomerSession(client: client)
		self.client = client
		self.session = session

		Task {
			let tokens = await session.restore()
			// A stored session belongs to one org; drop it when the tenant changes.
			if let tokens, tokens.orgId != organization.id {
				await session.signOut()
				isSignedIn = false
				return
			}
			isSignedIn = tokens != nil
			if tokens != nil { await loadProfile() }
		}
	}

	// MARK: - Authentication

	func sendCode(phone: String) async {
		guard let session else { return }
		guard PhoneNumber.isValid(phone) else {
			errorMessage = language.string("login.invalidPhone")
			return
		}
		isBusy = true
		errorMessage = nil
		do {
			try await session.sendCode(phone: phone)
			pendingPhone = PhoneNumber.normalize(phone)
		} catch let error as APIError {
			errorMessage = message(for: error)
		} catch {
			errorMessage = language.string("login.networkError")
		}
		isBusy = false
	}

	func verify(code: String) async {
		guard let session, let phone = pendingPhone else { return }
		authAttempt += 1
		let attempt = authAttempt
		isBusy = true
		errorMessage = nil
		defer {
			if attempt == authAttempt { isBusy = false }
		}

		do {
			let result = try await session.verify(phone: phone, code: code)
			guard attempt == authAttempt else { return }
			isSignedIn = true
			if result.needsName == true {
				needsName = true
			} else {
				await loadProfile()
			}
		} catch let error as APIError {
			guard attempt == authAttempt else { return }
			errorMessage = message(for: error)
		} catch {
			guard attempt == authAttempt else { return }
			errorMessage = language.string("login.networkError")
		}
	}

	func resendCode() async {
		guard let phone = pendingPhone else { return }
		await sendCode(phone: phone)
	}

	func cancelVerification() {
		// Abandon the attempt: an in-flight `verify` that lands later must not
		// sign the customer in, and its error must not reappear.
		authAttempt += 1
		pendingPhone = nil
		errorMessage = nil
		isBusy = false
	}

	func completeName(_ name: String) async {
		guard let session else { return }
		isBusy = true
		errorMessage = nil
		do {
			profile = try await session.updateProfile(name: name, email: nil)
			needsName = false
		} catch let error as APIError {
			errorMessage = message(for: error)
		} catch {
			errorMessage = language.string("login.networkError")
		}
		isBusy = false
	}

	func signOut() async {
		authAttempt += 1
		await session?.signOut()
		isSignedIn = false
		profile = nil
		needsName = false
		pendingPhone = nil
		errorMessage = nil
	}

	// MARK: - Profile

	func loadProfile() async {
		guard let session, isSignedIn else { return }
		do {
			let profile = try await session.profile()
			self.profile = profile
			if profile.needsName == true { needsName = true }
		} catch let error as APIError where error.isUnauthorized {
			isSignedIn = false
			profile = nil
		} catch {
			errorMessage = message(for: error)
		}
	}

	func saveProfile(name: String, email: String) async {
		guard let session else { return }
		isSavingProfile = true
		errorMessage = nil
		didSaveProfile = false
		do {
			profile = try await session.updateProfile(name: name, email: email)
			didSaveProfile = true
		} catch let error as APIError {
			errorMessage = message(for: error)
		} catch {
			errorMessage = language.string("profile.networkError")
		}
		isSavingProfile = false
	}

	func clearTransientMessages() {
		errorMessage = nil
		didSaveProfile = false
	}

	// MARK: - Helpers

	/// Server messages are English; transport failures get a localized one.
	private func message(for error: Error) -> String {
		guard let apiError = error as? APIError else {
			return language.string("login.networkError")
		}
		if apiError.isTransportFailure {
			return language.string("login.networkError")
		}
		return apiError.message
	}
}
