import { useLingui } from '@lingui/react/macro'
import * as Linking from 'expo-linking'
import { type PublicSiteAnnouncement } from '../../lib/api/public-site'
import { Banner, type BannerKind } from '../ui'

/** Same type-to-color mapping as the Sites announcement bar. */
export function announcementKind(type: string): BannerKind {
	if (type === 'warning') return 'warning'
	if (type === 'error') return 'error'
	return 'info'
}

/** Only web links leave the app: a `tel:` or custom scheme from a CMS field never runs. */
export function announcementLink(
	value: string | null | undefined,
): string | null {
	const trimmed = value?.trim()
	if (!trimmed) return null
	try {
		const url = new URL(trimmed)
		return url.protocol === 'https:' || url.protocol === 'http:'
			? url.toString()
			: null
	} catch {
		return null
	}
}

export function AnnouncementBanner({
	announcement,
}: {
	announcement: PublicSiteAnnouncement
}) {
	const { t } = useLingui()
	const link = announcementLink(announcement.linkUrl)
	return (
		<Banner
			kind={announcementKind(announcement.type)}
			actionLabel={
				link ? announcement.linkLabel?.trim() || t`Learn more` : undefined
			}
			onAction={link ? () => void Linking.openURL(link) : undefined}
		>
			{announcement.content}
		</Banner>
	)
}
