import { Trans } from '@lingui/macro'
import { useDoubleCheck } from '@repo/common'
import { Icon, type IconName } from '@repo/ui/icon'
import { StatusButton } from '@repo/ui/status-button'
import { useFetcher } from 'react-router'
import { disconnectProviderActionIntent } from '#app/routes/_app+/security.tsx'

interface Connection {
	id: string
	providerName: string
	providerId: string
	createdAt: Date
}

interface ConnectionsProps {
	data: {
		connections: Connection[]
	}
}

export function Connections({ data }: ConnectionsProps) {
	if (!data.connections.length) {
		return null
	}

	return (
		<div className="flex flex-col gap-4">
			<ul className="flex flex-col gap-4">
				{data.connections.map((connection) => {
					const createdAtDate = new Date(
						connection.createdAt,
					).toLocaleDateString()
					return (
						<li
							key={connection.id}
							className="flex items-center justify-between"
						>
							<div className="flex gap-2">
								<Icon
									name={connection.providerName as IconName}
									className="text-foreground h-8 w-8"
								/>
								<div className="flex flex-col gap-0">
									<div className="font-medium capitalize">
										{connection.providerName}
									</div>
									<span className="text-muted-foreground text-xs">
										<Trans>Connected on {createdAtDate}</Trans>
									</span>
								</div>
							</div>
							<DisconnectProvider connectionId={connection.id} />
						</li>
					)
				})}
			</ul>
		</div>
	)
}

interface DisconnectProviderProps {
	connectionId: string
	children?: React.ReactNode
}

export function DisconnectProvider({
	connectionId,
	children: _children,
}: DisconnectProviderProps) {
	const dc = useDoubleCheck()
	const fetcher = useFetcher()

	return (
		<fetcher.Form method="POST">
			<input type="hidden" name="connectionId" value={connectionId} />
			<StatusButton
				{...dc.getButtonProps({
					type: 'submit',
					name: 'intent',
					value: disconnectProviderActionIntent,
				})}
				variant={dc.doubleCheck ? 'destructive' : 'outline'}
				status={fetcher.state !== 'idle' ? 'pending' : 'idle'}
				size="sm"
			>
				{dc.doubleCheck ? (
					<Trans>Are you sure?</Trans>
				) : (
					<Trans>Disconnect</Trans>
				)}
			</StatusButton>
		</fetcher.Form>
	)
}
