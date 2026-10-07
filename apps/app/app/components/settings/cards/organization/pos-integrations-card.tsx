import { Trans, t } from '@lingui/macro'
import { getCrossAppUrl } from '@repo/common/url'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { StatusButton } from '@repo/ui/status-button'
import { useState } from 'react'
import { useFetcher } from 'react-router'

export const connectPosActionIntent = 'connect-pos'
export const disconnectPosActionIntent = 'disconnect-pos'
export const importPosMenuActionIntent = 'import-pos-menu'
export const syncPosMenuActionIntent = 'sync-pos-menu'

export interface PosIntegration {
	id: string
	providerName: string
	isActive: boolean
	lastSyncAt: string | null
	environment: 'sandbox' | 'live'
}

export interface PosProviderOption {
	name: string
	kind: string
	displayName: string
	description: string
	icon: string
	writeMode: string
}

export interface PosMenuOption {
	id: string
	name: string
}

const providerDomains: Record<string, string> = {
	clover: 'clover.com',
	square: 'squareup.com',
	toast: 'toasttab.com',
	ubereats: 'ubereats.com',
	doordash: 'doordash.com',
}

function relativeTime(value: string | null) {
	if (!value) return null
	const minutes = Math.max(
		0,
		Math.floor((Date.now() - new Date(value).getTime()) / 60000),
	)
	if (minutes < 1) return t`Just now`
	if (minutes < 60) return `${minutes}m ago`
	return `${Math.floor(minutes / 60)}h ago`
}

export function PosIntegrationCard({
	provider,
	integration,
	selectedLocationId,
	menus,
	doorDashLiveConfigured,
}: {
	provider: PosProviderOption
	integration: PosIntegration | null
	selectedLocationId: string
	menus: PosMenuOption[]
	doorDashLiveConfigured: boolean
}) {
	const fetcher = useFetcher()
	const [doorDashStoreId, setDoorDashStoreId] = useState('')
	const needsDoorDashStoreLink =
		provider.name === 'doordash' && doorDashLiveConfigured
	const isConnected = !!integration
	const isProcessing =
		fetcher.state !== 'idle' &&
		(fetcher.formData?.get('integrationId') === integration?.id ||
			fetcher.formData?.get('providerName') === provider.name)
	const isImportOnly = provider.writeMode === 'none'
	const lastSync = integration ? relativeTime(integration.lastSyncAt) : null
	const documentUrl = getCrossAppUrl('docs', `/integrations/${provider.name}`)

	return (
		<Card
			className="flex h-full flex-col"
			role="group"
			aria-label={provider.displayName}
		>
			<CardHeader className="flex w-full items-start gap-3">
				<div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-md after:absolute after:inset-0 after:h-full after:w-full after:rounded-[inherit] after:ring-1 after:ring-black/8 after:ring-inset dark:after:ring-white/8">
					<Icon name={provider.icon as never} className="h-6 w-6" />
				</div>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex items-center gap-2">
						<h4 className="truncate text-sm font-medium">
							{provider.displayName}
						</h4>
						{isConnected ? (
							<Badge variant="secondary">
								<Trans>Connected</Trans>
							</Badge>
						) : null}
					</div>
					<span className="text-muted-foreground text-xs">
						{providerDomains[provider.name] ?? `${provider.name}.com`}
					</span>
				</div>
			</CardHeader>

			<CardContent className="flex flex-1 flex-col gap-3">
				<p className="text-muted-foreground text-sm leading-5">
					{provider.description}
				</p>

				<div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
					<Badge
						variant={
							integration?.environment === 'live' ? 'secondary' : 'outline'
						}
					>
						{integration?.environment === 'live' ? (
							<Trans>Live</Trans>
						) : (
							<Trans>Sandbox</Trans>
						)}
					</Badge>
					<span>
						{provider.kind === 'delivery' ? (
							<Trans>Delivery</Trans>
						) : (
							<Trans>Point of sale</Trans>
						)}
					</span>
					{isConnected && lastSync ? (
						<span>
							<Trans>Synced {lastSync}</Trans>
						</span>
					) : null}
				</div>

				<div className="mt-auto pt-2">
					{isConnected && integration ? (
						<div className="flex flex-col gap-2">
							<fetcher.Form method="POST">
								<input
									type="hidden"
									name="intent"
									value={importPosMenuActionIntent}
								/>
								<input
									type="hidden"
									name="organizationLocationId"
									value={selectedLocationId}
								/>
								<input
									type="hidden"
									name="integrationId"
									value={integration.id}
								/>
								<Button
									type="submit"
									variant="outline"
									size="sm"
									className="w-full"
									disabled={isProcessing}
								>
									<Trans>Import menu</Trans>
								</Button>
							</fetcher.Form>

							{isImportOnly ? (
								<p className="text-muted-foreground text-xs">
									<Trans>
										This platform is import-only. Menu changes stay here.
									</Trans>
								</p>
							) : menus.length === 0 ? (
								<p className="text-muted-foreground text-xs">
									<Trans>Create a menu to sync it to this platform.</Trans>
								</p>
							) : (
								<div className="flex flex-col gap-1">
									{menus.map((menu) => (
										<fetcher.Form method="POST" key={menu.id}>
											<input
												type="hidden"
												name="intent"
												value={syncPosMenuActionIntent}
											/>
											<input
												type="hidden"
												name="organizationLocationId"
												value={selectedLocationId}
											/>
											<input
												type="hidden"
												name="integrationId"
												value={integration.id}
											/>
											<input type="hidden" name="menuId" value={menu.id} />
											<Button
												type="submit"
												variant="outline"
												size="sm"
												className="w-full justify-between"
												disabled={isProcessing}
											>
												<span className="truncate">
													<Trans>Sync</Trans> {menu.name}
												</span>
												<Icon name="refresh-cw" className="size-3.5" />
											</Button>
										</fetcher.Form>
									))}
								</div>
							)}

							<fetcher.Form method="POST">
								<input
									type="hidden"
									name="intent"
									value={disconnectPosActionIntent}
								/>
								<input
									type="hidden"
									name="organizationLocationId"
									value={selectedLocationId}
								/>
								<input
									type="hidden"
									name="integrationId"
									value={integration.id}
								/>
								<StatusButton
									type="submit"
									variant="ghost"
									size="sm"
									status={isProcessing ? 'pending' : 'idle'}
									className="w-full"
								>
									<Trans>Disconnect</Trans>
								</StatusButton>
							</fetcher.Form>
						</div>
					) : needsDoorDashStoreLink ? (
						<fetcher.Form method="POST" className="flex flex-col gap-3">
							<input
								type="hidden"
								name="intent"
								value={connectPosActionIntent}
							/>
							<input type="hidden" name="providerName" value={provider.name} />
							<input
								type="hidden"
								name="organizationLocationId"
								value={selectedLocationId}
							/>
							<div className="space-y-1.5">
								<Label htmlFor={`${provider.name}-store-id`}>
									<Trans>DoorDash store ID</Trans>
								</Label>
								<Input
									id={`${provider.name}-store-id`}
									name="doorDashStoreId"
									value={doorDashStoreId}
									onChange={(event) => setDoorDashStoreId(event.target.value)}
									placeholder={t`From DoorDash Portal or onboarding`}
									autoComplete="off"
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>
										One DoorDash store per connection. Use the store id DoorDash
										assigns after onboarding (SSIO or Store Onboarding).
									</Trans>
								</p>
							</div>
							<StatusButton
								type="submit"
								variant="outline"
								size="sm"
								status={isProcessing ? 'pending' : 'idle'}
								className="w-full"
								disabled={!selectedLocationId || !doorDashStoreId.trim()}
							>
								<Trans>Connect</Trans>
							</StatusButton>
						</fetcher.Form>
					) : (
						<fetcher.Form method="POST">
							<input
								type="hidden"
								name="intent"
								value={connectPosActionIntent}
							/>
							<input type="hidden" name="providerName" value={provider.name} />
							<input
								type="hidden"
								name="organizationLocationId"
								value={selectedLocationId}
							/>
							<StatusButton
								type="submit"
								variant="outline"
								size="sm"
								status={isProcessing ? 'pending' : 'idle'}
								className="w-full"
							>
								<Trans>Connect</Trans>
							</StatusButton>
						</fetcher.Form>
					)}
				</div>
			</CardContent>

			<CardFooter className="py-2">
				<a
					href={documentUrl}
					target="_blank"
					rel="noreferrer"
					className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between text-xs transition-colors"
				>
					<span className="flex items-center gap-1.5">
						<Icon name="book-open" className="h-4 w-4" />
						<Trans>Read documentation</Trans>
					</span>
					<Icon name="chevron-right" />
				</a>
			</CardFooter>
		</Card>
	)
}
