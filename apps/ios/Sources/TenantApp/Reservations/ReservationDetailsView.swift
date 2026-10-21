import SwiftUI
import TenantKit

/// The booking form. The phone is the signed-in customer's verified number: the
/// app never shows a phone field. With a payment policy the guest must accept the
/// terms before reviewing.
struct ReservationDetailsView: View {
	@EnvironmentObject private var store: ReservationsStore
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@Binding var path: [ReservationRoute]

	@State private var consented = false
	@State private var didPrefill = false

	private var isRequest: Bool { store.flow.hold == nil && store.flow.offersRequest }
	private var phone: String { state.profile?.phone ?? "" }

	var body: some View {
		ScrollView {
			VStack(spacing: 16) {
				if let countdown = store.holdCountdown, let remaining = store.holdRemaining {
					CountdownBanner(
						text: language.format("rsv.details.holding", ReservationsFormat.ltr(countdown)),
						isUrgent: remaining < 60
					)
				}
				summaryCard
				formCard
				if let hold = store.flow.hold, store.flow.needsPolicyConsent, let policy = hold.policy {
					PolicyPanel(policy: policy, partySize: hold.partySize, consented: $consented)
				}
				if case .failed(let failure) = store.flow.phase {
					ErrorBanner(failure: failure)
				}
				PrimaryButton(
					title: language.string(isRequest ? "rsv.search.request" : "rsv.details.review"),
					isLoading: store.isBusy,
					isEnabled: store.flow.canReview(store.draft, consented: consented) || isRequestReady
				) {
					store.draft.policyTermsVersion = consented ? store.flow.policyTermsVersion : nil
					if isRequest {
						Task { await store.submit(details: store.draft) }
					} else {
						store.proceedToReview()
					}
				}
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.details.title"))
		.onAppear(perform: prefill)
		.onChange(of: state.profile) { _, _ in prefill() }
		.onChange(of: consented) { _, value in
			store.draft.policyTermsVersion = value ? store.flow.policyTermsVersion : nil
		}
	}

	private var isRequestReady: Bool {
		isRequest && !store.draft.firstName.trimmingCharacters(in: .whitespaces).isEmpty
			&& PhoneNumber.isValid(store.draft.phone)
	}

	private var summaryCard: some View {
		let slot = store.flow.hold.map { ReservationSlot(localMin: $0.localMin) } ?? store.flow.selectedSlot
		return ThemedCard {
			VStack(alignment: .leading, spacing: 8) {
				Text(store.location?.name ?? "")
					.font(.headline)
					.foregroundStyle(palette.cardForeground)
				Text("\(ReservationsFormat.dateLabel(store.flow.hold?.date ?? store.flow.date, locale: language.locale)) \u{00B7} \(ReservationsFormat.ltr(slot?.time ?? "")) \u{00B7} \(language.format("rsv.search.partyCount", store.partySize))")
					.font(.subheadline)
					.foregroundStyle(palette.mutedForeground)
			}
		}
	}

	private var formCard: some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 16) {
				ThemedTextField(
					label: language.string("rsv.details.firstName"),
					placeholder: "",
					text: $store.draft.firstName,
					textContentType: .givenName
				)
				ThemedTextField(
					label: language.string("rsv.details.lastName"),
					placeholder: "",
					text: $store.draft.lastName,
					textContentType: .familyName
				)
				ThemedTextField(
					label: language.string("rsv.details.email"),
					placeholder: "jane@example.com",
					text: $store.draft.email,
					keyboardType: .emailAddress,
					textContentType: .emailAddress,
					autocapitalization: .never
				)
				Text(language.format("rsv.details.phoneNote", ReservationsFormat.ltr(PhoneNumber.display(phone))))
					.font(.caption)
					.foregroundStyle(palette.mutedForeground)

				if let config = store.config {
					chipMenu(
						title: language.string("rsv.details.occasion"),
						chips: config.occasions.map { (id: $0.id, name: $0.name) },
						selection: $store.draft.occasionTagId
					)
				}
				if let areas = store.location?.areas, areas.count > 1 {
					chipMenu(
						title: language.string("rsv.details.area"),
						chips: areas.map { (id: $0.id, name: $0.name) },
						selection: $store.draft.areaId,
						noneKey: "rsv.details.anyArea"
					)
				}
				ThemedTextField(
					label: language.string("rsv.details.dietary"),
					placeholder: store.config?.dietary.map(\.name).joined(separator: ", ") ?? "",
					text: $store.draft.dietary
				)
				ThemedTextField(
					label: language.string("rsv.details.requests"),
					placeholder: "",
					text: $store.draft.requests
				)
				Toggle(language.string("rsv.details.sms"), isOn: $store.draft.smsOptIn)
					.font(.subheadline)
					.foregroundStyle(palette.cardForeground)
			}
		}
	}

	private func chipMenu(
		title: String,
		chips: [(id: String, name: String)],
		selection: Binding<String?>,
		noneKey: String = "rsv.details.none"
	) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(title)
				.font(.subheadline.weight(.medium))
				.foregroundStyle(palette.foreground)
			Menu {
				Button(language.string(noneKey)) { selection.wrappedValue = nil }
				ForEach(chips, id: \.id) { chip in
					Button(chip.name) { selection.wrappedValue = chip.id }
				}
			} label: {
				HStack {
					Text(chips.first { $0.id == selection.wrappedValue }?.name ?? language.string(noneKey))
						.foregroundStyle(palette.cardForeground)
					Spacer()
					Image(systemName: "chevron.up.chevron.down")
						.font(.caption)
						.foregroundStyle(palette.mutedForeground)
				}
				.padding(.horizontal, 12)
				.padding(.vertical, 10)
				.frame(minHeight: 44)
				.overlay(
					RoundedRectangle(cornerRadius: max(palette.radius - 2, 6), style: .continuous)
						.strokeBorder(palette.border, lineWidth: 1)
				)
			}
		}
	}

	/// Name from the profile, phone from the verified account, language from the app.
	private func prefill() {
		store.draft.phone = phone
		store.draft.locale = language.code
		guard !didPrefill, let profile = state.profile else { return }
		let parts = (profile.name ?? "").split(separator: " ", maxSplits: 1).map(String.init)
		store.draft.firstName = parts.first ?? ""
		store.draft.lastName = parts.count > 1 ? parts[1] : ""
		store.draft.email = profile.email ?? ""
		didPrefill = true
	}
}

/// What the guest owes, the cancellation terms and the consent checkbox.
struct PolicyPanel: View {
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	let policy: ReservationPolicy
	let partySize: Int
	@Binding var consented: Bool

	var body: some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 10) {
				if policy.purpose == "guarantee" {
					Text(language.string("rsv.policy.guarantee"))
				} else {
					Text(language.format(
						"rsv.policy.deposit",
						ReservationsFormat.ltr(ReservationsFormat.money(policy.totalAmountMinor, currency: policy.currency, locale: language.locale))
					))
				}
				if policy.freeCancelUntilMin >= 60 {
					Text(language.format("rsv.policy.freeCancelHours", policy.freeCancelUntilMin / 60))
						.foregroundStyle(palette.mutedForeground)
				}
				if policy.lateCancelFeeMinor > 0 {
					Text(language.format(
						"rsv.policy.lateFee",
						ReservationsFormat.ltr(ReservationsFormat.money(policy.lateCancelFeeMinor, currency: policy.currency, locale: language.locale))
					))
					.foregroundStyle(palette.mutedForeground)
				}
				if policy.noShowFeeMinor > 0 {
					Text(language.format(
						"rsv.policy.noShowFee",
						ReservationsFormat.ltr(ReservationsFormat.money(policy.noShowFeeMinor, currency: policy.currency, locale: language.locale))
					))
					.foregroundStyle(palette.mutedForeground)
				}
				if let terms = policy.terms, !terms.isEmpty {
					Text(terms)
						.font(.footnote)
						.foregroundStyle(palette.mutedForeground)
				}
				Toggle(language.string("rsv.policy.consent"), isOn: $consented)
					.font(.subheadline.weight(.medium))
			}
			.font(.subheadline)
			.foregroundStyle(palette.cardForeground)
		}
	}
}
