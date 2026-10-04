import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
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

interface ReviewIntegrationsCardProps {
	selectedLocationId: string
	providers: ReviewIntegrationItem[]
}

export function ReviewIntegrationsCard({
	selectedLocationId,
	providers,
}: ReviewIntegrationsCardProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-xl">
					<Trans>Reviews & Listings</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Connect your restaurant pages across review and ordering platforms
						to monitor diner feedback and reply to reviews directly from Menuza.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					{providers.map((provider) => (
						<div
							key={provider.name}
							className="border-border/60 bg-card flex flex-col justify-between rounded-lg border p-4 shadow-xs"
						>
							<div>
								<div className="flex items-start justify-between gap-2">
									<div className="flex items-center gap-2.5">
										<div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
											<Icon
												name={provider.icon as any}
												className="text-foreground size-5"
											/>
										</div>
										<div>
											<h3 className="text-sm leading-none font-medium">
												{provider.displayName}
											</h3>
											<span className="text-muted-foreground mt-1 block text-xs">
												{provider.isActive ? (
													<span className="font-medium text-emerald-600 dark:text-emerald-400">
														● <Trans>Connected</Trans>
													</span>
												) : (
													<Trans>Not connected</Trans>
												)}
											</span>
										</div>
									</div>
									<Badge
										variant={provider.isActive ? 'default' : 'secondary'}
										className="text-[10px]"
									>
										{provider.isActive ? (
											<Trans>Active</Trans>
										) : (
											<Trans>Offline</Trans>
										)}
									</Badge>
								</div>
								<p className="text-muted-foreground mt-3 text-xs leading-relaxed">
									{provider.description}
								</p>
								{provider.error ? (
									<p role="alert" className="text-destructive mt-2 text-xs">
										{provider.error}
									</p>
								) : null}
							</div>

							<div className="border-border/40 mt-4 space-y-2 border-t pt-3">
								{provider.isActive ? (
									<div className="space-y-2">
										{provider.locations.length > 0 ? (
											<Form method="post" className="flex items-center gap-2">
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
													className="border-input bg-background h-8 flex-1 rounded-md border px-2 text-xs"
													required
												>
													{provider.locations.map((loc) => (
														<option key={loc.name} value={loc.name}>
															{loc.title}
														</option>
													))}
												</select>
												<Button type="submit" size="sm" variant="secondary">
													<Trans>Sync details</Trans>
												</Button>
											</Form>
										) : null}
										<div className="flex justify-end">
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
												<Button type="submit" variant="outline" size="sm">
													<Trans>Disconnect</Trans>
												</Button>
											</Form>
										</div>
									</div>
								) : (
									<div className="flex justify-end">
										<Form method="post" reloadDocument>
											<input
												type="hidden"
												name="intent"
												value={connectReviewActionIntent}
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
											<Button type="submit" size="sm">
												<Trans>Connect {provider.displayName}</Trans>
											</Button>
										</Form>
									</div>
								)}
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	)
}
