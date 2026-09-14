import SwiftUI
import TenantKit

/// The signed-in customer's profile: name + email are editable, the phone number
/// is the verified identity and stays read-only (same rule as Sites).
struct ProfileView: View {
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@State private var name = ""
	@State private var email = ""
	@State private var didLoad = false
	@FocusState private var focusedField: Field?

	private enum Field { case name, email }

	var body: some View {
		ScrollView {
			VStack(spacing: 20) {
				ThemedCard {
					VStack(alignment: .leading, spacing: 16) {
						VStack(alignment: .leading, spacing: 6) {
							Text(language.string("profile.title"))
								.font(.title3.weight(.semibold))
								.foregroundStyle(palette.cardForeground)
							Text(language.string("profile.subtitle"))
								.font(.subheadline)
								.foregroundStyle(palette.mutedForeground)
						}

						ThemedTextField(
							label: language.string("profile.name"),
							placeholder: language.string("name.placeholder"),
							text: $name,
							textContentType: .name
						)
						.focused($focusedField, equals: .name)

						ThemedTextField(
							label: language.string("profile.email"),
							placeholder: "jane@example.com",
							text: $email,
							keyboardType: .emailAddress,
							textContentType: .emailAddress,
							autocapitalization: .never
						)
						.focused($focusedField, equals: .email)

						ThemedTextField(
							label: language.string("profile.phone"),
							placeholder: "",
							text: .constant(PhoneNumber.display(state.profile?.phone ?? "")),
							isDisabled: true
						)

						Text(language.string("profile.phoneLocked"))
							.font(.caption)
							.foregroundStyle(palette.mutedForeground)

						if let errorMessage = state.errorMessage {
							FormMessage(text: errorMessage)
						}
						if state.didSaveProfile {
							FormMessage(text: language.string("profile.saved"), isSuccess: true)
						}

						PrimaryButton(
							title: language.string("profile.save"),
							isLoading: state.isSavingProfile,
							isEnabled: name.trimmingCharacters(in: .whitespaces).count >= 2
						) {
							focusedField = nil
							Task { await state.saveProfile(name: name, email: email) }
						}
					}
				}

				ThemedCard {
					VStack(alignment: .leading, spacing: 12) {
						Text(language.string("profile.language"))
							.font(.subheadline.weight(.semibold))
							.foregroundStyle(palette.cardForeground)

						Menu {
							Button(language.string("profile.languageSystem")) {
								state.languageOverride = nil
							}
							ForEach(state.availableLanguages, id: \.self) { code in
								Button(SiteLocale.label(code)) {
									state.languageOverride = code
								}
							}
						} label: {
							HStack {
								Text(state.languageOverride.map(SiteLocale.label) ?? language.string("profile.languageSystem"))
									.foregroundStyle(palette.cardForeground)
								Spacer()
								Image(systemName: "chevron.up.chevron.down")
									.font(.caption)
									.foregroundStyle(palette.mutedForeground)
							}
							.padding(.horizontal, 12)
							.padding(.vertical, 10)
							.overlay(
								RoundedRectangle(cornerRadius: max(palette.radius - 2, 6), style: .continuous)
									.strokeBorder(palette.border, lineWidth: 1)
							)
						}
					}
				}

				SecondaryButton(title: language.string("profile.signOut")) {
					Task { await state.signOut() }
				}
			}
			.padding(20)
		}
		.onAppear { loadFromProfile() }
		.onChange(of: state.profile) { _, _ in loadFromProfile() }
	}

	private func loadFromProfile() {
		guard let profile = state.profile else { return }
		if !didLoad || profile.name != name || (profile.email ?? "") != email {
			name = profile.name ?? ""
			email = profile.email ?? ""
			didLoad = true
		}
	}
}
