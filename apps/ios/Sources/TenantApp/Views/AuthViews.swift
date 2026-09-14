import SwiftUI
import TenantKit

/// Phone-OTP sign in — the same flow as `apps/sites` `/login` + `/verify`,
/// talking straight to the org's regional tenant-api.
struct LoginView: View {
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@State private var phone = ""
	@FocusState private var isFocused: Bool

	var body: some View {
		ScrollView {
			VStack(spacing: 20) {
				ThemedCard {
					VStack(alignment: .leading, spacing: 16) {
						VStack(alignment: .leading, spacing: 6) {
							Text(language.string("login.title"))
								.font(.title3.weight(.semibold))
								.foregroundStyle(palette.cardForeground)
							Text(language.string("login.subtitle"))
								.font(.subheadline)
								.foregroundStyle(palette.mutedForeground)
						}

						ThemedTextField(
							label: language.string("login.phone"),
							placeholder: language.string("login.phonePlaceholder"),
							text: $phone,
							keyboardType: .phonePad,
							textContentType: .telephoneNumber,
							autocapitalization: .never
						)
						.focused($isFocused)

						if let errorMessage = state.errorMessage {
							FormMessage(text: errorMessage)
						}

						PrimaryButton(
							title: language.string("login.action"),
							isLoading: state.isBusy,
							isEnabled: PhoneNumber.isValid(phone)
						) {
							isFocused = false
							Task { await state.sendCode(phone: phone) }
						}
					}
				}
			}
			.padding(20)
		}
		.onAppear {
			state.clearTransientMessages()
			isFocused = true
		}
	}
}

/// One-time code entry.
struct VerifyView: View {
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@State private var code = ""
	@FocusState private var isFocused: Bool

	private var phone: String {
		PhoneNumber.display(state.pendingPhone ?? "")
	}

	var body: some View {
		ScrollView {
			VStack(spacing: 20) {
				ThemedCard {
					VStack(alignment: .leading, spacing: 16) {
						VStack(alignment: .leading, spacing: 6) {
							Text(language.string("verify.title"))
								.font(.title3.weight(.semibold))
								.foregroundStyle(palette.cardForeground)
							Text(language.format("verify.subtitle", phone))
								.font(.subheadline)
								.foregroundStyle(palette.mutedForeground)
						}

						ThemedTextField(
							label: language.string("verify.code"),
							placeholder: "123456",
							text: $code,
							keyboardType: .numberPad,
							textContentType: .oneTimeCode,
							autocapitalization: .never
						)
						.focused($isFocused)

						if let errorMessage = state.errorMessage {
							FormMessage(text: errorMessage)
						}

						PrimaryButton(
							title: language.string("verify.action"),
							isLoading: state.isBusy,
							isEnabled: code.count == 6
						) {
							isFocused = false
							Task { await state.verify(code: code) }
						}

						HStack(spacing: 16) {
							Button(language.string("verify.resend")) {
								Task { await state.resendCode() }
							}
							Button(language.string("verify.changeNumber")) {
								state.cancelVerification()
							}
						}
						.buttonStyle(.plain)
						.font(.footnote.weight(.medium))
						.foregroundStyle(palette.primary)
					}
				}
			}
			.padding(20)
		}
		.onAppear {
			state.clearTransientMessages()
			isFocused = true
		}
	}
}

/// New customers pick a display name before the profile screen.
struct CompleteNameView: View {
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@State private var name = ""
	@FocusState private var isFocused: Bool

	var body: some View {
		ScrollView {
			VStack(spacing: 20) {
				ThemedCard {
					VStack(alignment: .leading, spacing: 16) {
						VStack(alignment: .leading, spacing: 6) {
							Text(language.string("name.title"))
								.font(.title3.weight(.semibold))
								.foregroundStyle(palette.cardForeground)
							Text(language.string("name.subtitle"))
								.font(.subheadline)
								.foregroundStyle(palette.mutedForeground)
						}

						ThemedTextField(
							label: language.string("name.field"),
							placeholder: language.string("name.placeholder"),
							text: $name,
							textContentType: .name
						)
						.focused($isFocused)

						if let errorMessage = state.errorMessage {
							FormMessage(text: errorMessage)
						}

						PrimaryButton(
							title: language.string("name.action"),
							isLoading: state.isBusy,
							isEnabled: name.trimmingCharacters(in: .whitespaces).count >= 2
						) {
							isFocused = false
							Task { await state.completeName(name) }
						}
					}
				}
			}
			.padding(20)
		}
		.onAppear { isFocused = true }
	}
}
