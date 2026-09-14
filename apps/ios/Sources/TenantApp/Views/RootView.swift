import SwiftUI
import TenantKit

struct RootView: View {
	@StateObject private var state = AppState()
	@Environment(\.colorScheme) private var systemColorScheme

	var body: some View {
		let language = state.language
		let palette = state.theme.palette(systemIsDark: systemColorScheme == .dark)

		VStack(spacing: 0) {
			BrandHeader(name: state.siteName, iconURL: state.iconURL)

			if let announcement = state.announcements.first {
				AnnouncementBanner(announcement: announcement)
			}

			content
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
		.background(palette.background.ignoresSafeArea())
		.environmentObject(state)
		.environment(\.themePalette, palette)
		.environment(\.appLanguage, language)
		.environment(\.locale, language.locale)
		.environment(\.layoutDirection, language.isRTL ? .rightToLeft : .leftToRight)
		.preferredColorScheme(state.theme.preferredColorScheme)
		.tint(palette.primary)
		.task { await state.start() }
	}

	@ViewBuilder
	private var content: some View {
		switch state.phase {
		case .loading:
			LoadingView()
		case .needsSite:
			ConnectSiteView()
		case .failed(let message):
			SiteUnavailableView(message: message)
		case .ready:
			if state.isSignedIn {
				if state.needsName {
					CompleteNameView()
				} else {
					ProfileView()
				}
			} else if state.pendingPhone != nil {
				VerifyView()
			} else {
				LoginView()
			}
		}
	}
}

struct LoadingView: View {
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	var body: some View {
		VStack(spacing: 12) {
			ProgressView()
			Text(language.string("app.loading"))
				.font(.footnote)
				.foregroundStyle(palette.mutedForeground)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

struct SiteUnavailableView: View {
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	let message: String

	var body: some View {
		VStack(spacing: 16) {
			Text(message)
				.font(.subheadline)
				.multilineTextAlignment(.center)
				.foregroundStyle(palette.mutedForeground)

			PrimaryButton(title: language.string("app.retry")) {
				Task { await state.retry() }
			}
			.frame(maxWidth: 240)
		}
		.padding(24)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

struct ConnectSiteView: View {
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@State private var address = ""
	@FocusState private var isFocused: Bool

	var body: some View {
		ScrollView {
			VStack(spacing: 20) {
				ThemedCard {
					VStack(alignment: .leading, spacing: 16) {
						VStack(alignment: .leading, spacing: 6) {
							Text(language.string("connect.title"))
								.font(.title3.weight(.semibold))
								.foregroundStyle(palette.cardForeground)
							Text(language.string("connect.subtitle"))
								.font(.subheadline)
								.foregroundStyle(palette.mutedForeground)
						}

						ThemedTextField(
							label: language.string("connect.fieldLabel"),
							placeholder: language.string("connect.placeholder"),
							text: $address,
							keyboardType: .URL,
							autocapitalization: .never
						)
						.focused($isFocused)

						if let errorMessage = state.errorMessage {
							FormMessage(text: errorMessage)
						}

						PrimaryButton(
							title: language.string("connect.action"),
							isLoading: state.phase == .loading,
							isEnabled: !address.trimmingCharacters(in: .whitespaces).isEmpty
						) {
							isFocused = false
							Task { await state.connect(to: address) }
						}
					}
				}
			}
			.padding(20)
		}
		.onAppear { isFocused = true }
	}
}
