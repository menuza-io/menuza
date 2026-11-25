import { invariantResponse } from '@epic-web/invariant'
import { auditService, AuditAction } from '@repo/audit'
import { getUserId, userHasOrganizationPermission } from '@repo/auth'
import { GbpError } from '@repo/common/gbp-listing'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	asc,
	db,
	eq,
	Integration as IntegrationTable,
	OrganizationLocation,
	OrganizationMenu,
} from '@repo/database'
import {
	canProviderOwnField,
	deliveryMenuLimits,
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
	isPosProvider,
	isPosSandboxConnectAllowed,
	isReviewProvider,
	isSyncFailing,
	listDeliverooLocations,
	listGoogleBusinessLocations,
	listJustEatLocations,
	listOpenTableLocations,
	listResyVenues,
	listTripAdvisorLocations,
	listYelpLocations,
	localizedText,
	parsePosConfig,
	posOwnershipFields,
	providerKind,
	pushMenu,
	resolveFieldOwnership,
	validateFieldOwnership,
	type PosProvider,
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
	redirect,
	useLoaderData,
} from 'react-router'
import {
	IntegrationsCard,
	connectIntegrationActionIntent,
	disconnectIntegrationActionIntent,
} from '#app/components/settings/cards/organization/integrations-card.tsx'
import {
	checkDeliveryMenuActionIntent,
	connectPosActionIntent,
	disconnectPosActionIntent,
	fixDeliveryMenuActionIntent,
	goLiveStoreActionIntent,
	importPosMenuActionIntent,
	retryDeliveryPauseActionIntent,
	savePosOwnershipActionIntent,
	saveStoreSettingsActionIntent,
	syncPosMenuActionIntent,
} from '#app/components/settings/cards/organization/pos-integrations-card.tsx'
import {
	connectReviewActionIntent,
	disconnectReviewActionIntent,
	importReviewActionIntent,
	type ReviewIntegrationItem,
} from '#app/components/settings/cards/organization/review-integrations-card.tsx'
import { onGoogleLocationLinked } from '#app/utils/gbp/sweep.server.ts'
import { retryDeliveryPause } from '#app/utils/integrations/delivery-pause.server.ts'
import {
	isDeliveryPauseEnabled,
	isMenuCheckEnabled,
	isPosOwnershipEnabled,
	isStoreSettingsEnabled,
} from '#app/utils/integrations/flags.server.ts'
import {
	fixDeliveryMenuByPushing,
	loadDeliveryMenuCheckSummaries,
	runDeliveryMenuCheck,
	type DeliveryMenuCheckSummary,
} from '#app/utils/integrations/menu-check.server.ts'
import { setIntegrationOAuthState } from '#app/utils/integrations/oauth-state.server.ts'
import { connectPosPlatform } from '#app/utils/integrations/pos-connect.server.ts'
import { connectReviewProvider } from '#app/utils/integrations/review-providers.server.ts'
import {
	evaluateStoreReadiness,
	goLiveDeliveryStore,
	saveStoreSettings,
} from '#app/utils/integrations/store-readiness.server.ts'
import { getLocationDisplayName } from '#app/utils/location/locations.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { requireOrganizationAdmin } from '#app/utils/organization/require-org-admin.server.ts'
import { recordOrganizationEvent } from '#app/utils/organization-events.server.ts'

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

	const userId = await getUserId(request)
	const [
		integrations,
		menus,
		locationRows,
		posOwnershipEnabled,
		deliveryPauseEnabled,
		storeSettingsEnabled,
		menuCheckEnabled,
		canManageIntegrations,
	] = await Promise.all([
		integrationManager.getOrganizationIntegrations(organization.id),
		db.query.OrganizationMenu.findMany({
			where: eq(OrganizationMenu.organizationId, organization.id),
			orderBy: [asc(OrganizationMenu.position)],
		}),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				timezone: OrganizationLocation.timezone,
				isDefault: OrganizationLocation.isDefault,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organization.id))
			.orderBy(asc(OrganizationLocation.name)),
		isPosOwnershipEnabled(organization.id),
		isDeliveryPauseEnabled(organization.id),
		isStoreSettingsEnabled(organization.id),
		isMenuCheckEnabled(organization.id),
		userId
			? userHasOrganizationPermission(
					userId,
					organization.id,
					ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
				)
			: Promise.resolve(false),
	])

	let locations = locationRows
	if (!locations.length) {
		const defaultId = await ensureDefaultOrganizationLocation(organization.id)
		locations = [
			{
				id: defaultId,
				name: organization.name,
				timezone: 'UTC',
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
	const selectedLocationTimezone =
		locations.find((location) => location.id === selectedLocationId)
			?.timezone || 'UTC'
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

	const scopedPosIntegrations = scopedIntegrations.filter((integration) =>
		posProviderNames.has(integration.providerName),
	)
	const menuCheckSummaries: Map<string, DeliveryMenuCheckSummary> =
		menuCheckEnabled
			? await loadDeliveryMenuCheckSummaries(
					scopedPosIntegrations.filter(
						(integration) =>
							isPosProvider(integration.providerName) &&
							providerKind[integration.providerName] === 'delivery',
					),
				)
			: new Map<string, DeliveryMenuCheckSummary>()

	return {
		organization,
		reviewProviders,
		availablePosProviders,
		availableNoteProviders,
		selectedLocationId,
		// Only what the page shows. The full rows carry token ciphertext and the
		// connected notes (including private ones), and any member can load this.
		noteIntegrations: integrations
			.filter(
				(integration) =>
					!posProviderNames.has(integration.providerName) &&
					!reviewProviderNames.has(integration.providerName as any),
			)
			.map((integration) => ({
				id: integration.id,
				providerName: integration.providerName,
				providerType: integration.providerType,
				isActive: integration.isActive,
				lastSyncAt: integration.lastSyncAt,
				config: integration.config,
				_count: { connections: integration.connections?.length ?? 0 },
			})),
		integrations: await Promise.all(
			scopedPosIntegrations.map(async (integration) => {
				const isPosKind =
					isPosProvider(integration.providerName) &&
					providerKind[integration.providerName] === 'pos'
				const isDeliveryKind =
					isPosProvider(integration.providerName) &&
					providerKind[integration.providerName] === 'delivery'
				const parsedConfig = parsePosConfig(integration.config)
				const syncFailing = isSyncFailing(parsedConfig)
				const lastSyncError = parsedConfig.syncHealth?.lastError ?? null
				const pause = parsedConfig.pause
				const pauseActive =
					pause != null &&
					(pause.openEnded ||
						(pause.pausedUntil != null &&
							Date.parse(pause.pausedUntil) > Date.now()))
				const readiness =
					storeSettingsEnabled && isDeliveryKind
						? await evaluateStoreReadiness(organization.id, integration.id)
						: undefined
				return {
					id: integration.id,
					providerName: integration.providerName,
					isActive: integration.isActive,
					lastSyncAt: integration.lastSyncAt
						? integration.lastSyncAt.toISOString()
						: null,
					environment: parsedConfig.environment,
					syncFailing,
					lastSyncError,
					...(deliveryPauseEnabled && isDeliveryKind
						? {
								pausedUntil: pauseActive ? (pause?.pausedUntil ?? null) : null,
								pauseOpenEnded: pauseActive ? Boolean(pause?.openEnded) : false,
								lastPauseError: pause?.lastPauseError ?? null,
							}
						: {}),
					...(storeSettingsEnabled && isDeliveryKind && readiness
						? {
								storeSettings: {
									menuIds: parsedConfig.store?.menuIds ?? [],
									holidaySync: parsedConfig.store?.holidaySync ?? false,
									live: parsedConfig.store?.live ?? false,
									lastHolidaySyncAt:
										parsedConfig.store?.lastHolidaySyncAt ?? null,
									menuLimit:
										deliveryMenuLimits[
											integration.providerName as PosProvider
										] ?? 5,
								},
								readiness,
								managedByPos: readiness.managedByPos,
							}
						: {}),
					...(menuCheckEnabled && isDeliveryKind
						? { menuCheck: menuCheckSummaries.get(integration.id) }
						: {}),
					...(posOwnershipEnabled && isPosKind
						? {
								fieldOwnership: resolveFieldOwnership(
									integration.providerName as PosProvider,
									integration.config,
								),
								supportedOwnershipFields: posOwnershipFields.filter((field) =>
									canProviderOwnField(
										integration.providerName as PosProvider,
										field,
									),
								),
							}
						: {}),
				}
			}),
		),
		posOwnershipEnabled,
		deliveryPauseEnabled,
		storeSettingsEnabled,
		menuCheckEnabled,
		selectedLocationTimezone,
		canManageIntegrations,
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

	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

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

			const { authUrl, state, requestTokenSecret } =
				await integrationManager.initiateOAuth(
					organization.id,
					providerName,
					redirectUri,
					{ redirectUrl: redirectTo },
				)

			// The callback finishes only what this browser started, for this
			// member (see api+/integrations+/oauth.callback.tsx).
			return redirect(authUrl, {
				headers: {
					'Set-Cookie': await setIntegrationOAuthState({
						state,
						provider: providerName,
						userId,
						orgSlug: organization.slug,
						...(requestTokenSecret ? { requestTokenSecret } : {}),
					}),
				},
			})
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
		await recordOrganizationEvent({
			organizationId: organization.id,
			kind: 'integration_disconnected',
			payload: { provider: integration.providerName || 'unknown' },
			dedupeKey: `integration:${integrationId}:disconnected:${Math.floor(Date.now() / 60_000)}`,
		})
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
				const imported = await importGoogleBusinessLocation(
					organization.id,
					locationName,
					locationFromForm || undefined,
				)
				const linkedLocationId = locationFromForm || imported.menuzaLocationId
				if (linkedLocationId) {
					await onGoogleLocationLinked({
						organizationId: organization.id,
						organizationLocationId: linkedLocationId,
					})
				}
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
			const taken =
				error instanceof GbpError && error.code === 'gbp_location_taken'
			return redirectWithToast(redirectTo, {
				title: taken ? 'Google location already linked' : 'Sync failed',
				description: taken
					? 'This Google Business Profile location is already linked to another Menuza location.'
					: error instanceof Error
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
			const parts = [
				`${result.created} item${result.created === 1 ? '' : 's'} imported`,
			]
			if (result.updated > 0) {
				const changedList = result.changes
					.slice(0, 3)
					.map((c) => `${c.name} (${c.fields.join(', ')})`)
					.join('; ')
				const extra =
					result.changes.length > 3 ? ` +${result.changes.length - 3} more` : ''
				parts.push(
					`${result.updated} updated${changedList ? `: ${changedList}${extra}` : ''}`,
				)
			}
			parts.push(`${result.skipped} unchanged`)
			return redirectWithToast(redirectTo, {
				title: 'Menu imported',
				description: `${parts.join(', ')}.`,
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

	if (intent === savePosOwnershipActionIntent) {
		if (!(await isPosOwnershipEnabled(organization.id))) {
			return Response.json({ ok: false, error: 'feature_off' }, { status: 404 })
		}
		const integrationId = String(formData.get('integrationId') ?? '').trim()
		if (!integrationId) {
			return Response.json(
				{ ok: false, error: 'missing_integration_id' },
				{ status: 400 },
			)
		}
		const [integration] = await db
			.select()
			.from(IntegrationTable)
			.where(
				and(
					eq(IntegrationTable.id, integrationId),
					eq(IntegrationTable.organizationId, organization.id),
				),
			)
			.limit(1)
		if (!integration) {
			return Response.json(
				{ ok: false, error: 'integration_not_found' },
				{ status: 404 },
			)
		}
		if (
			!isPosProvider(integration.providerName) ||
			providerKind[integration.providerName] !== 'pos'
		) {
			return Response.json(
				{ ok: false, error: 'not_pos_integration' },
				{ status: 400 },
			)
		}

		let rawOwnership: unknown = undefined
		const jsonField = formData.get('fieldOwnership')
		if (typeof jsonField === 'string' && jsonField.trim()) {
			try {
				rawOwnership = JSON.parse(jsonField)
			} catch {
				return Response.json(
					{ ok: false, error: 'invalid_json' },
					{ status: 400 },
				)
			}
		} else {
			const collected: Record<string, unknown> = {}
			for (const [key, val] of formData.entries()) {
				if (
					key === 'intent' ||
					key === 'integrationId' ||
					key === 'organizationLocationId'
				) {
					continue
				}
				const normalizedKey = key.startsWith('fieldOwnership.')
					? key.slice('fieldOwnership.'.length)
					: key
				collected[normalizedKey] = val
			}
			rawOwnership = collected
		}

		const validation = validateFieldOwnership(
			integration.providerName as PosProvider,
			rawOwnership,
		)
		if (!validation.ok) {
			return Response.json(
				{
					ok: false,
					error: 'invalid_field_ownership',
					invalidFields: validation.invalidFields,
				},
				{ status: 400 },
			)
		}

		let existingConfig: Record<string, unknown> = {}
		if (typeof integration.config === 'string' && integration.config.trim()) {
			try {
				const parsed = JSON.parse(integration.config)
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					existingConfig = parsed as Record<string, unknown>
				}
			} catch {}
		}
		const nextConfig = JSON.stringify({
			...existingConfig,
			fieldOwnership: validation.fieldOwnership,
		})
		await db
			.update(IntegrationTable)
			.set({ config: nextConfig, updatedAt: new Date() })
			.where(eq(IntegrationTable.id, integration.id))

		await auditService.log({
			action: AuditAction.ORG_SETTINGS_UPDATED,
			userId,
			organizationId: organization.id,
			resourceType: 'integration',
			resourceId: integration.id,
			details: `Updated POS field ownership for ${integration.providerName}.`,
			metadata: {
				provider: integration.providerName,
				fieldOwnership: validation.fieldOwnership,
			},
			request,
		})

		return redirectWithToast(redirectTo, {
			title: 'Ownership updated',
			description: 'Field ownership settings were saved.',
			type: 'success',
		})
	}

	if (intent === syncPosMenuActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		const menuId = String(formData.get('menuId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		invariantResponse(menuId, 'Menu ID is required', { status: 400 })
		try {
			const respectPosOwnership = await isPosOwnershipEnabled(organization.id)
			const result = await pushMenu(integrationId, organization.id, menuId, {
				respectPosOwnership,
			})
			return redirectWithToast(redirectTo, {
				title: 'Menu synced',
				description: `${result.pushed} item${result.pushed === 1 ? '' : 's'} pushed to the platform.`,
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Sync failed',
				description: error instanceof Error ? error.message : 'Unknown error',
				type: 'error',
			})
		}
	}

	if (intent === saveStoreSettingsActionIntent) {
		if (!(await isStoreSettingsEnabled(organization.id))) {
			return Response.json({ ok: false, error: 'feature_off' }, { status: 404 })
		}
		const integrationId = String(formData.get('integrationId') ?? '').trim()
		if (!integrationId) {
			return Response.json(
				{ ok: false, error: 'missing_integration_id' },
				{ status: 400 },
			)
		}
		const rawMenuIds = formData.getAll('menuIds').map((entry) => String(entry))
		let menuIds: string[] = rawMenuIds
		if (rawMenuIds.length === 1 && rawMenuIds[0]!.trim().startsWith('[')) {
			try {
				const parsed = JSON.parse(rawMenuIds[0]!)
				if (Array.isArray(parsed)) {
					menuIds = parsed.map((entry) => String(entry))
				}
			} catch {
				return Response.json(
					{ ok: false, error: 'invalid_menu_ids' },
					{ status: 400 },
				)
			}
		}
		const holidaySyncRaw = String(
			formData.get('holidaySync') ?? '',
		).toLowerCase()
		const holidaySync = holidaySyncRaw === 'true' || holidaySyncRaw === 'on'
		try {
			const result = await saveStoreSettings(organization.id, integrationId, {
				menuIds,
				holidaySync,
			})
			return Response.json({
				ok: true,
				store: result.store,
				readiness: result.readiness,
			})
		} catch (error) {
			const status =
				error instanceof Error &&
				'status' in error &&
				typeof error.status === 'number'
					? error.status
					: 400
			const code =
				error instanceof Error &&
				'code' in error &&
				typeof error.code === 'string'
					? error.code
					: undefined
			return Response.json(
				{
					ok: false,
					error: error instanceof Error ? error.message : 'Unknown error',
					...(code ? { code } : {}),
				},
				{ status },
			)
		}
	}

	if (intent === goLiveStoreActionIntent) {
		if (!(await isStoreSettingsEnabled(organization.id))) {
			return Response.json({ ok: false, error: 'feature_off' }, { status: 404 })
		}
		const integrationId = String(formData.get('integrationId') ?? '').trim()
		if (!integrationId) {
			return Response.json(
				{ ok: false, error: 'missing_integration_id' },
				{ status: 400 },
			)
		}
		try {
			const result = await goLiveDeliveryStore(organization.id, integrationId)
			if (!result.ok) {
				return Response.json(
					{
						ok: false,
						error: result.error,
						reasons: result.reasons,
						readiness: result.readiness,
					},
					{ status: result.status },
				)
			}
			return Response.json({ ok: true, readiness: result.readiness })
		} catch (error) {
			const status =
				error instanceof Error &&
				'status' in error &&
				typeof error.status === 'number'
					? error.status
					: 400
			return Response.json(
				{
					ok: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				},
				{ status },
			)
		}
	}

	if (intent === retryDeliveryPauseActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '').trim()
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		const result = await retryDeliveryPause(organization.id, integrationId)
		if (!result.ok) {
			if (result.status === 404 || result.status === 400) {
				return Response.json(
					{ ok: false, error: result.error },
					{ status: result.status },
				)
			}
			return redirectWithToast(redirectTo, {
				title: 'Retry failed',
				description:
					result.store?.error ??
					'Could not update the delivery store pause state.',
				type: 'error',
			})
		}
		return redirectWithToast(redirectTo, {
			title:
				result.status === 'paused'
					? 'Delivery store paused'
					: 'Delivery store resumed',
			description: 'The delivery platform status was updated.',
			type: 'success',
		})
	}

	if (intent === checkDeliveryMenuActionIntent) {
		if (!(await isMenuCheckEnabled(organization.id))) {
			return Response.json({ ok: false, error: 'feature_off' }, { status: 404 })
		}
		const integrationId = String(formData.get('integrationId') ?? '').trim()
		if (!integrationId) {
			return Response.json(
				{ ok: false, error: 'missing_integration_id' },
				{ status: 400 },
			)
		}
		const result = await runDeliveryMenuCheck(integrationId, organization.id, {
			trigger: 'manual',
		})
		if (!result.ok) {
			return Response.json(
				{
					ok: false,
					error: result.error,
					...(result.message ? { message: result.message } : {}),
					...(result.menuCheck ? { menuCheck: result.menuCheck } : {}),
				},
				{ status: result.status },
			)
		}
		return Response.json({
			ok: true,
			menuCheck: result.menuCheck,
			diffs: result.diffs,
			errorDiffCount: result.errorDiffCount,
			posChangedCount: result.posChangedCount,
			totalDiffCount: result.totalDiffCount,
		})
	}

	if (intent === fixDeliveryMenuActionIntent) {
		if (!(await isMenuCheckEnabled(organization.id))) {
			return Response.json({ ok: false, error: 'feature_off' }, { status: 404 })
		}
		const integrationId = String(formData.get('integrationId') ?? '').trim()
		if (!integrationId) {
			return Response.json(
				{ ok: false, error: 'missing_integration_id' },
				{ status: 400 },
			)
		}
		const result = await fixDeliveryMenuByPushing(
			integrationId,
			organization.id,
		)
		if (!result.ok) {
			return Response.json(
				{ ok: false, error: result.error },
				{ status: result.status },
			)
		}
		return Response.json(result)
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function IntegrationsSettings() {
	const {
		organization,
		integrations,
		availablePosProviders,
		availableNoteProviders,
		noteIntegrations,
		menus,
		locations,
		doorDashLiveConfigured,
		posOwnershipEnabled,
		deliveryPauseEnabled,
		storeSettingsEnabled,
		menuCheckEnabled,
		selectedLocationTimezone,
		canManageIntegrations,
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
				posOwnershipEnabled={posOwnershipEnabled}
				deliveryPauseEnabled={deliveryPauseEnabled}
				storeSettingsEnabled={storeSettingsEnabled}
				menuCheckEnabled={menuCheckEnabled}
				locationTimezone={selectedLocationTimezone}
				canManageIntegrations={canManageIntegrations}
				orgSlug={organization.slug}
			/>
		</div>
	)
}
