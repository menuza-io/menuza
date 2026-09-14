import SwiftUI
import TenantKit

/// Branded chrome: the org's icon, name, and any active announcements.
struct BrandHeader: View {
	@Environment(\.themePalette) private var palette
	@Environment(\.appLanguage) private var language

	let name: String
	let iconURL: URL?

	var body: some View {
		HStack(spacing: 12) {
			if let iconURL {
				AsyncImage(url: iconURL) { image in
					image.resizable().scaledToFit()
				} placeholder: {
					Color.clear
				}
				.frame(width: 36, height: 36)
				.clipShape(RoundedRectangle(cornerRadius: max(palette.radius * 0.7, 6), style: .continuous))
			}

			Text(name)
				.font(.system(size: 17, weight: .semibold, design: .rounded))
				.foregroundStyle(palette.foreground)
				.lineLimit(1)

			Spacer()
		}
		.padding(.horizontal, 20)
		.padding(.vertical, 14)
		.background(palette.background)
		.overlay(alignment: .bottom) {
			Rectangle()
				.fill(palette.border)
				.frame(height: 1)
		}
		.accessibilityElement(children: .combine)
	}
}

/// Mirrors the Sites announcement banner (type → colors).
struct AnnouncementBanner: View {
	@Environment(\.themePalette) private var palette

	let announcement: PublicSiteAnnouncement

	private var background: Color {
		switch announcement.type {
		case "warning": return palette.accent
		case "error": return palette.destructive
		case "success": return palette.primary
		default: return palette.primary
		}
	}

	private var foreground: Color {
		switch announcement.type {
		case "warning": return palette.accentForeground
		case "error": return palette.destructiveForeground
		default: return palette.primaryForeground
		}
	}

	var body: some View {
		HStack(spacing: 8) {
			Text(announcement.content)
				.font(.footnote.weight(.medium))
				.multilineTextAlignment(.center)

			if let linkUrl = announcement.linkUrl, let url = URL(string: linkUrl) {
				Link(announcement.linkLabel ?? "Learn more", destination: url)
					.font(.footnote.weight(.semibold))
					.underline()
			}
		}
		.frame(maxWidth: .infinity)
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.background(background)
		.foregroundStyle(foreground)
	}
}
