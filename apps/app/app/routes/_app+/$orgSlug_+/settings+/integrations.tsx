import { invariantResponse } from '@epic-web/invariant'
import { redirectWithToast } from '@repo/common/toast'
import {
	asc,
	db,
	eq,
	OrganizationLocation,
	OrganizationMenu,
} from '@repo/database'
import {
	ensureDefaultOrganizationLocation,
	getAvailablePosProviders,
	getAvailableProviders,
	getAvailableReviewProviders,
	hasAppCredentials,
	importCatalog,
	importDeliverooLocation,
	importGoogleBusinessLocation,
	importJustEatLocation,
	importOpenTableLocation,
	importResyVenue,
	importTripAdvisorLocation,
	importYelpLocation,
	integrationManager,
	isPosSandboxConnectAllowed,
	isReviewProvider,
	listDeliverooLocations,
	listGoogleBusinessLocations,
	listJustEatLocations,
	listOpenTableLocations,
	listResyVenues,
	listTripAdvisorLocations,
	listYelpLocations,
	localizedText,
	parsePosConfig,
	pushMenu,
	type ReviewProviderName,
} from '@repo/integrations'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useLoaderData,
} from 'react-router'
import {
	IntegrationsCard,
	connectIntegrationActionIntent,
	disconnectIntegrationActionIntent,
} from '#app/components/settings/cards/organization/integrations-card.tsx'
import {
	connectPosActionIntent,
	disconnectPosActionIntent,
	importPosMenuActionIntent,
	syncPosMenuActionIntent,
} from '#app/components/settings/cards/organization/pos-integrations-card.tsx'
import {
	connectReviewActionIntent,
	disconnectReviewActionIntent,
	importReviewActionIntent,
	type ReviewIntegrationItem,
} from '#app/components/settings/cards/organization/review-integrations-card.tsx'
import { connectPosPlatform } from '#app/utils/integrations/pos-connect.server.ts'
import { connectReviewProvider } from '#app/utils/integrations/review-providers.server.ts'
import { getLocationDisplayName } from '#app/utils/location/locations.ts'
import { recordChannelSync } from '#app/utils/menu/publish.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireOrganizationAdmin } from '#app/utils/organization/require-org-admin.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	const url = new URL(request.url)
	const availablePosProviders = getAvailablePosProviders()
	const availableNoteProviders = getAvailableProviders()
	const posProviderNames = new Set(availablePosProviders.map((p) => p.name))

	const [integrations, menus, locationRows] = await Promise.all([
		integrationManager.getOrganizationIntegrations(organization.id),
		db.query.OrganizationMenu.findMany({
			where: eq(OrganizationMenu.organizationId, organization.id),
			orderBy: [asc(OrganizationMenu.position)],
		}),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				isDefault: OrganizationLocation.isDefault,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organization.id))
			.orderBy(asc(OrganizationLocation.name)),
	])

	let locations = locationRows
	if (!locations.length) {
		const defaultId = await ensureDefaultOrganizationLocation(organization.id)
		locations = [
			{
				id: defaultId,
				name: organization.name,
				isDefault: true,
			},
		]
	}

	const defaultLocationId =
		locations.find((location) => location.isDefault)?.id ??
		locations[0]?.id ??
		''
	const selectedLocationId =
		url.searchParams.get('locationId')?.trim() || defaultLocationId
	const scopedIntegrations = integrations.filter(
		(item) => item.organizationLocationId === selectedLocationId,
	)

	const availableReviewProviders = getAvailableReviewProviders()
	const reviewProviderNames = new Set(
		availableReviewProviders.map((p) => p.name),
	)

	const reviewProviders: ReviewIntegrationItem[] = await Promise.all(
		availableReviewProviders.map(async (provider) => {
			const integration = scopedIntegrations.find(
				(item) => item.providerName === provider.name,
			)
			let locations: Array<{ name: string; title: string }> = []
			let error: string | null = null
			if (integration?.isActive) {
				try {
					if (provider.name === 'google-business-profile') {
						locations = (
							await listGoogleBusinessLocations(
								organization.id,
								selectedLocationId,
							)
						).map(({ name, title }) => ({ name, title }))
					} else if (provider.name === 'yelp') {
						locations = (
							await listYelpLocations(organization.id, selectedLocationId)
						).map(({ id, name }) => ({ name: id, title: name }))
					} else if (provider.name === 'tripadvisor') {
						locations = (
							await listTripAdvisorLocations(
								organization.id,
								selectedLocationId,
							)
						).map(({ location_id, name }) => ({
							name: location_id,
							title: name,
						}))
					} else if (provider.name === 'deliveroo') {
						locations = (
							await listDeliverooLocations(organization.id, selectedLocationId)
						).map(({ id, name }) => ({ name: id, title: name }))
					} else if (provider.name === 'just-eat') {
						locations = (
							await listJustEatLocations(organization.id, selectedLocationId)
						).map(({ id, name }) => ({ name: id, title: name }))
					} else if (provider.name === 'opentable') {
						locations = (
							await listOpenTableLocations(organization.id, selectedLocationId)
						).map(({ rid, name }) => ({ name: rid, title: name }))
					} else if (provider.name === 'resy') {
						locations = (
							await listResyVenues(organization.id, selectedLocationId)
						).map(({ venue_id, name }) => ({ name: venue_id, title: name }))
					}
				} catch (err) {
					error =
						err instanceof Error
							? err.message
							: `Could not load ${provider.displayName} locations`
				}
			}
			return {
				name: provider.name,
				displayName: provider.displayName,
				description: provider.description,
				icon: provider.icon,
				isActive: Boolean(integration?.isActive),
				integrationId: integration?.id,
				locations,
				error,
			}
		}),
	)

	return {
		organization,
		reviewProviders,
		availablePosProviders,
		availableNoteProviders,
		selectedLocationId,
		noteIntegrations: integrations.filter(
			(integration) =>
				!posProviderNames.has(integration.providerName) &&
				!reviewProviderNames.has(integration.providerName as any),
		),
		integrations: scopedIntegrations
			.filter((integration) => posProviderNames.has(integration.providerName))
			.map((integration) => ({
				id: integration.id,
				providerName: integration.providerName,
				isActive: integration.isActive,
				lastSyncAt: integration.lastSyncAt
					? integration.lastSyncAt.toISOString()
					: null,
				environment: parsePosConfig(integration.config).environment,
			})),
		menus: menus.map((menu) => ({
			id: menu.id,
			name: localizedText(menu.displayName, 'Menu'),
		})),
		locations,
		doorDashLiveConfigured: hasAppCredentials('doordash'),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	const formData = await request.formData()
	const intent = formData.get('intent')
	const locationFromForm = String(
		formData.get('organizationLocationId') ?? '',
	).trim()
	const redirectTo = locationFromForm
		? `/${organization.slug}/settings/integrations?locationId=${encodeURIComponent(locationFromForm)}`
		: `/${organization.slug}/settings/integrations`

	const adminRequired = new Set([
		connectIntegrationActionIntent,
		disconnectIntegrationActionIntent,
		'connect-google-business-profile',
		'disconnect-google-business-profile',
		'import-google-business-profile',
		connectReviewActionIntent,
		disconnectReviewActionIntent,
		importReviewActionIntent,
		connectPosActionIntent,
		disconnectPosActionIntent,
		importPosMenuActionIntent,
		syncPosMenuActionIntent,
	])
	if (typeof intent === 'string' && adminRequired.has(intent)) {
		await requireOrganizationAdmin(request, organization.id)
	}

	if (intent === connectIntegrationActionIntent) {
		const providerName = String(formData.get('providerName') ?? '')
		if (!providerName) {
			return redirectWithToast(redirectTo, {
				title: 'Integration failed',
				description: 'No provider was selected.',
				type: 'error',
			})
		}
		try {
			const url = new URL(request.url)
			const protocol = url.protocol === 'https:' ? 'https:' : 'http:'
			const redirectUri = `${protocol}//${url.host}/api/integrations/oauth/callback?provider=${encodeURIComponent(providerName)}`
			const { authUrl } = await integrationManager.initiateOAuth(
				organization.id,
				providerName,
				redirectUri,
				{ redirectUrl: redirectTo },
			)
			return Response.redirect(authUrl)
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Integration failed',
				description:
					error instanceof Error ? error.message : 'Failed to initiate OAuth',
				type: 'error',
			})
		}
	}

	if (intent === disconnectIntegrationActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		const integration = await integrationManager.getIntegration(integrationId)
		invariantResponse(integration, 'Integration not found', { status: 404 })
		invariantResponse(
			integration.organizationId === organization.id,
			'Unauthorized',
			{ status: 403 },
		)
		await integrationManager.disconnectIntegration(integrationId)
		return redirectWithToast(redirectTo, {
			title: 'Disconnected',
			description: 'The integration was disconnected.',
			type: 'success',
		})
	}

	if (
		intent === connectReviewActionIntent ||
		intent === 'connect-google-business-profile'
	) {
		const rawProvider = String(
			formData.get('providerName') || 'google-business-profile',
		)
		if (!isReviewProvider(rawProvider)) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: 'Unknown review platform.',
				type: 'error',
			})
		}
		const providerName = rawProvider as ReviewProviderName
		if (!locationFromForm) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: 'Select a restaurant location first.',
				type: 'error',
			})
		}
		try {
			return await connectReviewProvider(
				request,
				organization.id,
				providerName,
				redirectTo,
				locationFromForm,
			)
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description:
					error instanceof Error
						? error.message
						: `Could not connect ${providerName}`,
				type: 'error',
			})
		}
	}

	if (
		intent === importReviewActionIntent ||
		intent === 'import-google-business-profile'
	) {
		const providerName = String(
			formData.get('providerName') || 'google-business-profile',
		)
		if (!isReviewProvider(providerName)) {
			return redirectWithToast(redirectTo, {
				title: 'Import failed',
				description: 'Unknown review platform.',
				type: 'error',
			})
		}
		const locationName = String(formData.get('locationName') ?? '')
		try {
			if (providerName === 'google-business-profile') {
				await importGoogleBusinessLocation(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
			} else if (providerName === 'yelp') {
				await importYelpLocation(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
			} else if (providerName === 'tripadvisor') {
				await importTripAdvisorLocation(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
			} else if (providerName === 'deliveroo') {
				await importDeliverooLocation(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
			} else if (providerName === 'just-eat') {
				await importJustEatLocation(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
			} else if (providerName === 'opentable') {
				await importOpenTableLocation(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
			} else if (providerName === 'resy') {
				await importResyVenue(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
			}
			return redirectWithToast(redirectTo, {
				title: 'Details synced',
				description: 'Restaurant and listing details were updated.',
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Sync failed',
				description:
					error instanceof Error
						? error.message
						: 'Could not sync listing details',
				type: 'error',
			})
		}
	}

	if (
		intent === disconnectReviewActionIntent ||
		intent === 'disconnect-google-business-profile'
	) {
		const providerName = String(
			formData.get('providerName') || 'google-business-profile',
		)
		if (!isReviewProvider(providerName)) {
			return redirectWithToast(redirectTo, {
				title: 'Disconnect failed',
				description: 'Unknown review platform.',
				type: 'error',
			})
		}
		const integrationsForOrg =
			await integrationManager.getOrganizationIntegrations(organization.id)
		const target = integrationsForOrg.find(
			(item) =>
				item.providerName === providerName &&
				item.organizationLocationId === locationFromForm,
		)
		if (target) await integrationManager.disconnectIntegration(target.id)
		return redirectWithToast(redirectTo, {
			title: 'Disconnected',
			description: 'The integration was disconnected.',
			type: 'success',
		})
	}

	if (intent === connectPosActionIntent) {
		if (!locationFromForm) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: 'Select a restaurant location first.',
				type: 'error',
			})
		}
		const providerName = String(formData.get('providerName') ?? '')
		if (!providerName) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: 'No provider was selected.',
				type: 'error',
			})
		}
		try {
			const oauthRedirect = await connectPosPlatform(
				request,
				organization.id,
				providerName,
				{
					afterRedirectUrl: redirectTo,
					organizationLocationId: locationFromForm,
					doorDashStoreId: String(formData.get('doorDashStoreId') ?? ''),
				},
			)
			if (oauthRedirect) return oauthRedirect
			return redirectWithToast(redirectTo, {
				title: 'Connected',
				description: isPosSandboxConnectAllowed()
					? 'Platform connected in sandbox mode. Store details were imported when available.'
					: 'Platform connected. Store details were imported when available.',
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: error instanceof Error ? error.message : 'Unknown error',
				type: 'error',
			})
		}
	}

	if (intent === disconnectPosActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		const integration = await integrationManager.getIntegration(integrationId)
		invariantResponse(integration, 'Integration not found', { status: 404 })
		invariantResponse(
			integration.organizationId === organization.id,
			'Unauthorized',
			{ status: 403 },
		)
		await integrationManager.disconnectIntegration(integrationId)
		return redirectWithToast(redirectTo, {
			title: 'Disconnected',
			description: 'The platform was disconnected.',
			type: 'success',
		})
	}

	if (intent === importPosMenuActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		try {
			const result = await importCatalog(integrationId, organization.id)
			return redirectWithToast(redirectTo, {
				title: 'Menu imported',
				description: `${result.created} item${result.created === 1 ? '' : 's'} imported, ${result.skipped} already linked.`,
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Import failed',
				description: error instanceof Error ? error.message : 'Unknown error',
				type: 'error',
			})
		}
	}

	if (intent === syncPosMenuActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		const menuId = String(formData.get('menuId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		invariantResponse(menuId, 'Menu ID is required', { status: 400 })
		try {
			const result = await pushMenu(integrationId, organization.id, menuId)
			await recordChannelSync({
				organizationId: organization.id,
				menuId,
				integrationId,
				status: 'success',
				pushedCount: result.pushed,
			})
			return redirectWithToast(redirectTo, {
				title: 'Menu synced',
				description: `${result.pushed} item${result.pushed === 1 ? '' : 's'} pushed to the platform.`,
				type: 'success',
			})
		} catch (error) {
			await recordChannelSync({
				organizationId: organization.id,
				menuId,
				integrationId,
				status: 'error',
				error: error instanceof Error ? error.message : 'Unknown error',
			})
			return redirectWithToast(redirectTo, {
				title: 'Sync failed',
				description: error instanceof Error ? error.message : 'Unknown error',
				type: 'error',
			})
		}
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function IntegrationsSettings() {
	const {
		integrations,
		availablePosProviders,
		availableNoteProviders,
		noteIntegrations,
		menus,
		locations,
		doorDashLiveConfigured,
		selectedLocationId,
		reviewProviders,
	} = useLoaderData<typeof loader>()

	const locationPicker =
		locations.length > 1 ? (
			<Card>
				<CardHeader>
					<CardTitle>Restaurant location</CardTitle>
					<CardDescription>
						Integrations apply to the selected location. Each location can have
						its own POS, delivery, and review platform connections.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-2">
					{locations.map((location) => (
						<Link
							key={location.id}
							to={`?locationId=${location.id}`}
							className={
								location.id === selectedLocationId
									? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium'
									: 'bg-muted hover:bg-muted/80 rounded-md px-3 py-1.5 text-sm'
							}
						>
							{getLocationDisplayName(location.name)}
						</Link>
					))}
				</CardContent>
			</Card>
		) : null

	return (
		<div className="space-y-6">
			{locationPicker}
			<IntegrationsCard
				integrations={noteIntegrations}
				availableProviders={availableNoteProviders}
				selectedLocationId={selectedLocationId}
				reviewProviders={reviewProviders}
				posIntegrations={integrations}
				availablePosProviders={availablePosProviders}
				menus={menus}
				doorDashLiveConfigured={doorDashLiveConfigured}
			/>
		</div>
	)
}
