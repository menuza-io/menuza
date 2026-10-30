import { type ReactNode } from 'react'
import { View } from 'react-native'
import { organizationIconUrl } from '../../lib/api/public-site'
import { useAppSnapshot } from '../../lib/app/use-app'
import { InsetView } from '../ui'
import { AnnouncementBanner } from './announcement-banner'
import { AppGate } from './app-gate'
import { BrandHeader } from './brand-header'

/** The branded frame around every screen: header, first announcement, content. */
export function AppShell({ children }: { children: ReactNode }) {
	const { organization, configuration } = useAppSnapshot()
	const announcement = organization?.announcements?.[0] ?? null
	return (
		<View className="bg-background flex-1">
			<InsetView edges={['top']}>
				{organization ? (
					<BrandHeader
						name={organization.name}
						iconUrl={organizationIconUrl(
							organization,
							configuration.appBaseUrl,
						)}
					/>
				) : null}
			</InsetView>
			{announcement ? <AnnouncementBanner announcement={announcement} /> : null}
			<View className="flex-1">
				<AppGate>{children}</AppGate>
			</View>
		</View>
	)
}
