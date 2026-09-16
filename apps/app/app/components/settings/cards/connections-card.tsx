import { Trans } from '@lingui/macro'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Connections } from '#app/components/settings/connections.tsx'
import {
	ProviderConnectionForm,
	useConfiguredProviders,
} from '#app/utils/connections.tsx'

export const disconnectProviderActionIntent = 'disconnect-provider'

interface ConnectionsCardProps {
	connections: Array<{
		id: string
		providerName: string
		providerId: string
		createdAt: Date
	}>
	user: {
		id: string
		name: string | null
		username: string
		email: string
	}
}

export function ConnectionsCard({ connections }: ConnectionsCardProps) {
	const configuredProviders = useConfiguredProviders()

	return (
		<Card className="w-full">
			<CardHeader>
				<CardTitle>
					<Trans>Connected Accounts</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>Manage your connected accounts here.</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Connections data={{ connections }} />
				<div className="border-border mt-5 flex flex-col gap-5 border-t-2 border-b-2 py-3">
					<h3 className="text-center text-sm font-medium">
						<Trans>Add more connections</Trans>
					</h3>
					{configuredProviders.map((providerName) => (
						<ProviderConnectionForm
							key={providerName}
							type="Connect"
							providerName={providerName}
						/>
					))}
				</div>
			</CardContent>
		</Card>
	)
}
