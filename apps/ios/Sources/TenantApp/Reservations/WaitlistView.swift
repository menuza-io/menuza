import SwiftUI
import TenantKit

/// Join the waitlist (a verified phone is the contact) and follow the position.
struct WaitlistView: View {
	@EnvironmentObject private var store: ReservationsStore
	@EnvironmentObject private var state: AppState
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@State private var name = ""
	@State private var smsOptIn = false

	var body: some View {
		ScrollView {
			VStack(spacing: 16) {
				switch store.waitlist.phase {
				case .idle, .joining, .failed:
					joinCard
				case .waiting, .left, .seated, .linkInvalid:
					statusCard
				}
			}
			.padding(20)
		}
		.background(palette.background)
		.navigationTitle(language.string("rsv.waitlist.title"))
		.onAppear { prefill() }
		.task(id: store.waitlist.statusToken) {
			// Refresh the position while the screen is open.
			while store.waitlist.statusToken != nil, !Task.isCancelled {
				await store.refreshWaitlist()
				if [.left, .seated, .linkInvalid].contains(store.waitlist.phase) { break }
				try? await Task.sleep(nanoseconds: 10_000_000_000)
			}
		}
	}

	private var joinCard: some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 16) {
				Text(store.location?.name ?? "")
					.font(.headline)
					.foregroundStyle(palette.cardForeground)
				PartyStepper(value: $store.partySize, range: 1...max(store.location?.partySize.max ?? 8, 2))
				ThemedTextField(
					label: language.string("rsv.waitlist.name"),
					placeholder: "",
					text: $name,
					textContentType: .name
				)
				Text(language.format("rsv.details.phoneNote", ReservationsFormat.ltr(PhoneNumber.display(state.profile?.phone ?? ""))))
					.font(.caption)
					.foregroundStyle(palette.mutedForeground)
				Toggle(language.string("rsv.details.sms"), isOn: $smsOptIn)
					.font(.subheadline)
				if case .failed(let failure) = store.waitlist.phase {
					ErrorBanner(failure: failure)
				}
				PrimaryButton(
					title: language.string("rsv.waitlist.join"),
					isLoading: store.isBusy,
					isEnabled: !name.trimmingCharacters(in: .whitespaces).isEmpty
						&& PhoneNumber.isValid(state.profile?.phone ?? "")
				) {
					Task {
						await store.joinWaitlist(
							name: name.trimmingCharacters(in: .whitespaces),
							phone: state.profile?.phone ?? "",
							smsOptIn: smsOptIn
						)
					}
				}
			}
		}
	}

	@ViewBuilder
	private var statusCard: some View {
		ThemedCard {
			VStack(alignment: .leading, spacing: 12) {
				switch store.waitlist.phase {
				case .left:
					Text(language.string("rsv.waitlist.left"))
				case .seated:
					Text(language.string("rsv.waitlist.seated"))
				case .linkInvalid:
					Text(language.string("rsv.waitlist.invalid"))
				default:
					if let status = store.waitlist.status {
						if status.status == "notified" {
							Text(language.string("rsv.waitlist.notified"))
								.font(.title3.weight(.semibold))
						} else if let position = status.position {
							Text(language.format("rsv.waitlist.position", position))
								.font(.title3.weight(.semibold))
						}
						if let quoted = status.quotedMin, quoted > 0 {
							Text(language.format("rsv.waitlist.quoted", quoted))
								.foregroundStyle(palette.mutedForeground)
						}
						if status.canOnMyWay {
							PrimaryButton(title: language.string("rsv.waitlist.onMyWay"), isLoading: store.isBusy) {
								Task { await store.waitlistOnMyWay() }
							}
						}
						if status.canLeave {
							SecondaryButton(title: language.string("rsv.waitlist.leave")) {
								Task { await store.leaveWaitlist() }
							}
						}
					} else {
						ProgressView()
					}
				}
				if case .linkInvalid = store.waitlist.phase {
					SecondaryButton(title: language.string("rsv.confirmed.done")) { store.resetWaitlist() }
				}
			}
			.font(.subheadline)
			.foregroundStyle(palette.cardForeground)
		}
	}

	private func prefill() {
		if name.isEmpty { name = state.profile?.name ?? "" }
	}
}
