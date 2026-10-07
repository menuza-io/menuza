import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Form } from 'react-router'

export const connectReviewActionIntent = 'connect-review-provider'
export const disconnectReviewActionIntent = 'disconnect-review-provider'
export const importReviewActionIntent = 'import-review-provider'

export interface ReviewProviderLocation {
	name: string
	title: string
}

export interface ReviewIntegrationItem {
	name: string
	displayName: string
	description: string
	icon: string
	isActive: boolean
	integrationId?: string
	locations: ReviewProviderLocation[]
	error: string | null
}

interface ReviewIntegrationCardProps {
	selectedLocationId: string
	provider: ReviewIntegrationItem
}

export function ReviewIntegrationCard({
	selectedLocationId,
	provider,
}: ReviewIntegrationCardProps) {
	const displayName = provider.displayName

	return (
		<Card
			className="flex h-full flex-col"
			role="group"
			aria-label={provider.displayName}
		>
			<CardHeader className="flex w-full items-start gap-3">
				<div className="bg-muted grid size-10 shrink-0 place-items-center rounded-md">
					<Icon name={provider.icon as any} className="size-6" />
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2">
						<h4 className="text-sm font-medium">{provider.displayName}</h4>
						{provider.isActive ? (
							<Badge variant="secondary">
								<Trans>Connected</Trans>
							</Badge>
						) : null}
					</div>
					{!provider.isActive ? (
						<span className="text-muted-foreground text-xs">
							<Trans>Not connected</Trans>
						</span>
					) : null}
				</div>
			</CardHeader>
			<CardContent className="flex flex-1 flex-col gap-3">
				<p className="text-muted-foreground text-sm leading-5">
					{provider.description}
				</p>
				{provider.error ? (
					<p role="alert" className="text-destructive text-xs">
						{provider.error}
					</p>
				) : null}

				<div className="mt-auto space-y-2 pt-2">
					{provider.isActive ? (
						<>
							{provider.locations.length > 0 ? (
								<Form method="post" className="flex flex-col gap-2">
									<input
										type="hidden"
										name="intent"
										value={importReviewActionIntent}
									/>
									<input
										type="hidden"
										name="providerName"
										value={provider.name}
									/>
									<input
										type="hidden"
										name="organizationLocationId"
										value={selectedLocationId}
									/>
									<select
										name="locationName"
										aria-label={`${provider.displayName} location`}
										className="border-input bg-background h-8 w-full min-w-0 rounded-md border px-2 text-xs"
										required
									>
										{provider.locations.map((loc) => (
											<option key={loc.name} value={loc.name}>
												{loc.title}
											</option>
										))}
									</select>
									<Button
										type="submit"
										size="sm"
										variant="secondary"
										className="w-full"
									>
										<Trans>Sync details</Trans>
									</Button>
								</Form>
							) : null}
							<Form method="post">
								<input
									type="hidden"
									name="intent"
									value={disconnectReviewActionIntent}
								/>
								<input
									type="hidden"
									name="providerName"
									value={provider.name}
								/>
								<input
									type="hidden"
									name="organizationLocationId"
									value={selectedLocationId}
								/>
								<Button
									type="submit"
									variant="outline"
									size="sm"
									className="w-full"
								>
									<Trans>Disconnect</Trans>
								</Button>
							</Form>
						</>
					) : (
						<Form method="post" reloadDocument>
							<input
								type="hidden"
								name="intent"
								value={connectReviewActionIntent}
							/>
							<input type="hidden" name="providerName" value={provider.name} />
							<input
								type="hidden"
								name="organizationLocationId"
								value={selectedLocationId}
							/>
							<Button
								type="submit"
								size="sm"
								variant="outline"
								className="w-full"
							>
								<Trans>Connect {displayName}</Trans>
							</Button>
						</Form>
					)}
				</div>
			</CardContent>
		</Card>
	)
}
