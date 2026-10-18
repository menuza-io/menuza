import SwiftUI
import TenantKit

/// A selectable pill: a time slot or a day in the date strip. At least 44 points
/// tall, with an explicit selected state for VoiceOver.
struct ChipButton: View {
	@Environment(\.themePalette) private var palette

	let title: String
	var subtitle: String?
	var isSelected = false
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			VStack(spacing: 2) {
				if let subtitle {
					Text(subtitle)
						.font(.caption2)
						.foregroundStyle(isSelected ? palette.primaryForeground : palette.mutedForeground)
				}
				Text(title)
					.font(.subheadline.weight(.semibold))
					.monospacedDigit()
					.foregroundStyle(isSelected ? palette.primaryForeground : palette.foreground)
			}
			.frame(minWidth: 56, minHeight: 44)
			.padding(.horizontal, 10)
			.background(isSelected ? palette.primary : palette.card)
			.clipShape(RoundedRectangle(cornerRadius: max(palette.radius - 2, 6), style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: max(palette.radius - 2, 6), style: .continuous)
					.strokeBorder(isSelected ? palette.primary : palette.border, lineWidth: 1)
			)
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}

/// "Table held for 6:42": the live hold countdown on the server's clock.
struct CountdownBanner: View {
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	let text: String
	var isUrgent = false

	var body: some View {
		HStack(spacing: 8) {
			Image(systemName: "timer")
			Text(text)
				.font(.footnote.weight(.semibold))
				.monospacedDigit()
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(12)
		.background(isUrgent ? palette.destructive.opacity(0.12) : palette.muted)
		.foregroundStyle(isUrgent ? palette.destructive : palette.foreground)
		.clipShape(RoundedRectangle(cornerRadius: max(palette.radius - 2, 6), style: .continuous))
		.accessibilityElement(children: .combine)
	}
}

struct StatusBadge: View {
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	let status: String

	var body: some View {
		Text(language.string(reservationStatusKey(status)))
			.font(.caption.weight(.semibold))
			.padding(.horizontal, 10)
			.padding(.vertical, 4)
			.background(palette.muted)
			.foregroundStyle(palette.foreground)
			.clipShape(Capsule())
	}
}

/// Label on the left, value on the right; values keep their own direction.
struct DetailRow: View {
	@Environment(\.themePalette) private var palette

	let label: String
	let value: String

	var body: some View {
		HStack(alignment: .firstTextBaseline) {
			Text(label)
				.font(.subheadline)
				.foregroundStyle(palette.mutedForeground)
			Spacer(minLength: 12)
			Text(value)
				.font(.subheadline.weight(.medium))
				.foregroundStyle(palette.cardForeground)
				.multilineTextAlignment(.trailing)
		}
		.accessibilityElement(children: .combine)
	}
}

struct PartyStepper: View {
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	@Binding var value: Int
	let range: ClosedRange<Int>

	var body: some View {
		HStack {
			Text(language.string("rsv.search.party"))
				.font(.subheadline.weight(.medium))
				.foregroundStyle(palette.foreground)
			Spacer()
			Stepper(
				value: $value,
				in: range
			) {
				Text(language.format("rsv.search.partyCount", value))
					.font(.subheadline.weight(.semibold))
					.monospacedDigit()
			}
			.labelsHidden()
			Text(language.format("rsv.search.partyCount", value))
				.font(.subheadline.weight(.semibold))
				.monospacedDigit()
				.foregroundStyle(palette.foreground)
				.frame(minWidth: 72, alignment: .trailing)
		}
	}
}

struct ErrorBanner: View {
	@Environment(\.appLanguage) private var language

	let failure: BookingFailure

	var body: some View {
		FormMessage(text: language.string(failure.messageKey))
			.accessibilityAddTraits(.updatesFrequently)
	}
}

/// The adaptive grid the time chips live in.
let reservationChipColumns = [GridItem(.adaptive(minimum: 76), spacing: 8)]
