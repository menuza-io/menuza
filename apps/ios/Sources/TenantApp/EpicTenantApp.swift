import SwiftUI

/// Tenant iOS app: a branded shell around the customer's tenant-api session.
///
/// The app is deliberately thin — it renders the org's branding (theme, icon,
/// name, announcements) from the published Sites payload and lets a customer
/// sign in with phone OTP and manage their profile. Content pages stay on the
/// org's website.
@main
struct EpicTenantApp: App {
	var body: some Scene {
		WindowGroup {
			RootView()
		}
	}
}
