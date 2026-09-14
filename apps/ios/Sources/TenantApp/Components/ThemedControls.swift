import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// Shared, themed building blocks. Everything reads the org palette from the
/// environment so a tenant's branding flows through the whole app.
struct ThemedCard<Content: View>: View {
	@Environment(\.themePalette) private var palette

	let content: Content

	init(@ViewBuilder content: () -> Content) {
		self.content = content()
	}

	var body: some View {
		content
			.padding(24)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(palette.card)
			.foregroundStyle(palette.cardForeground)
			.clipShape(RoundedRectangle(cornerRadius: palette.radius, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: palette.radius, style: .continuous)
					.strokeBorder(palette.border, lineWidth: 1)
			)
	}
}

struct PrimaryButton: View {
	@Environment(\.themePalette) private var palette

	let title: String
	var isLoading = false
	var isEnabled = true
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: 8) {
				if isLoading {
					ProgressView()
						.controlSize(.small)
						.tint(palette.primaryForeground)
				}
				Text(title)
					.fontWeight(.semibold)
			}
			.frame(maxWidth: .infinity)
			.padding(.vertical, 12)
		}
		.buttonStyle(.plain)
		.background(palette.primary)
		.foregroundStyle(palette.primaryForeground)
		.clipShape(RoundedRectangle(cornerRadius: palette.radius, style: .continuous))
		.opacity(isEnabled && !isLoading ? 1 : 0.6)
		.disabled(!isEnabled || isLoading)
	}
}

struct SecondaryButton: View {
	@Environment(\.themePalette) private var palette

	let title: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Text(title)
				.fontWeight(.medium)
				.frame(maxWidth: .infinity)
				.padding(.vertical, 12)
		}
		.buttonStyle(.plain)
		.foregroundStyle(palette.foreground)
		.overlay(
			RoundedRectangle(cornerRadius: palette.radius, style: .continuous)
				.strokeBorder(palette.border, lineWidth: 1)
		)
	}
}

struct ThemedTextField: View {
	@Environment(\.themePalette) private var palette

	let label: String
	let placeholder: String
	@Binding var text: String
	var isDisabled = false
	var keyboardType: UIKeyboardType = .default
	var textContentType: UITextContentType?
	var autocapitalization: TextInputAutocapitalization = .sentences

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(label)
				.font(.subheadline.weight(.medium))
				.foregroundStyle(palette.foreground)

			TextField(placeholder, text: $text)
				.keyboardType(keyboardType)
				.textContentType(textContentType)
				.textInputAutocapitalization(autocapitalization)
				.autocorrectionDisabled()
				.disabled(isDisabled)
				.padding(.horizontal, 12)
				.padding(.vertical, 10)
				.background(palette.background)
				.foregroundStyle(isDisabled ? palette.mutedForeground : palette.foreground)
				.clipShape(RoundedRectangle(cornerRadius: max(palette.radius - 2, 6), style: .continuous))
				.overlay(
					RoundedRectangle(cornerRadius: max(palette.radius - 2, 6), style: .continuous)
						.strokeBorder(palette.border, lineWidth: 1)
				)
		}
	}
}

struct FormMessage: View {
	@Environment(\.themePalette) private var palette

	let text: String
	var isSuccess = false

	var body: some View {
		Text(text)
			.font(.footnote.weight(.medium))
			.foregroundStyle(isSuccess ? palette.primary : palette.destructive)
			.frame(maxWidth: .infinity, alignment: .leading)
	}
}
