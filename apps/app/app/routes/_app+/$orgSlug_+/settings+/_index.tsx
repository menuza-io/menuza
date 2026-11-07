import { parseWithZod } from '@conform-to/zod/v4'
import { parseFormData } from '@mjackson/form-data-parser'
import { requireUserId } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'
import { organizationSlugSchema } from '@repo/common'
import { markStepCompleted } from '@repo/common/onboarding'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	db,
	eq,
	inArray,
	Organization,
	OrganizationImage,
	OrganizationInvitation,
	OrganizationRole,
	OrganizationS3Config,
	or,
	sql,
	SSOConfiguration,
	SSOSession,
	User,
} from '@repo/database'
import {
	decrypt,
	encrypt,
	getSSOMasterKey,
	validateInstanceUrlWithDns,
} from '@repo/security'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
	useActionData,
} from 'react-router'
import { z } from 'zod'

import DangerZoneCard from '#app/components/settings/cards/organization/danger-zone-card.tsx'
import { GeneralSettingsCard } from '#app/components/settings/cards/organization/general-settings-card.tsx'
import {
	uploadOrgPhotoActionIntent,
	deleteOrgPhotoActionIntent,
} from '#app/components/settings/cards/organization/organization-photo-card.tsx'
import {
	S3StorageCard,
	S3StorageSchema,
	s3StorageActionIntent,
	startS3MigrationActionIntent,
} from '#app/components/settings/cards/organization/s3-storage-card.tsx'
import TeamSizeCard, {
	TeamSizeSchema,
} from '#app/components/settings/cards/organization/team-size-card.tsx'
import VerifiedDomainCard, {
	VerifiedDomainSchema,
} from '#app/components/settings/cards/organization/verified-domain-card.tsx'

import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireOrganizationAdmin,
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
	userIsOrganizationAdmin,
} from '#app/utils/organization/permissions.server.ts'
import { isPublicEmailDomain } from '#app/utils/organization/public-email-domains.ts'
import {
	checkDomainClaim,
	domainVerificationRecordName,
	domainVerificationRecordValue,
	inviteExistingDomainUsers,
	isDomainClaimedElsewhere,
	startDomainClaim,
} from '#app/utils/organization/verified-domain.server.ts'
import { deleteSubscription } from '#app/utils/payments.server.ts'
import { deprovisionTenantDatabase } from '#app/utils/sites/tenant-api.server.ts'
import {
	countOrgMediaObjectKeys,
	createAndStartStorageMigration,
	customSnapshotFromS3ConfigRow,
	getActiveStorageMigration,
	getLatestStorageMigration,
	previousSnapshotFieldsFromConfig,
	resolveStorageMigrationPlan,
	s3BucketSettingsChanged,
} from '#app/utils/storage-migration.server.ts'
import {
	uploadOrganizationImage,
	testS3Connection,
} from '#app/utils/storage.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		size: true,
		verifiedDomain: true,
		verifiedDomainProvedAt: true,
		pendingVerifiedDomain: true,
		verifiedDomainToken: true,
		stripeSubscriptionId: true,
	})
	// The TXT record to publish for a pending claim; the token itself only
	// travels inside that record value.
	const { verifiedDomainToken, ...organizationFields } = organization
	const domainClaim =
		organization.pendingVerifiedDomain && verifiedDomainToken
			? {
					domain: organization.pendingVerifiedDomain,
					recordName: domainVerificationRecordName(
						organization.pendingVerifiedDomain,
					),
					recordValue: domainVerificationRecordValue(verifiedDomainToken),
				}
			: null

	const [s3Config, image] = await Promise.all([
		db
			.select({
				id: OrganizationS3Config.id,
				isEnabled: OrganizationS3Config.isEnabled,
				endpoint: OrganizationS3Config.endpoint,
				bucketName: OrganizationS3Config.bucketName,
				accessKeyId: OrganizationS3Config.accessKeyId,
				secretAccessKey: OrganizationS3Config.secretAccessKey,
				region: OrganizationS3Config.region,
			})
			.from(OrganizationS3Config)
			.where(eq(OrganizationS3Config.organizationId, organization.id))
			.limit(1)
			// The page only needs to know a secret is stored; its ciphertext
			// never goes to the browser.
			.then((rows) => {
				const row = rows[0]
				if (!row) return null
				const { secretAccessKey, ...rest } = row
				return { ...rest, hasSecretAccessKey: Boolean(secretAccessKey) }
			}),
		db
			.select({
				id: OrganizationImage.id,
				objectKey: OrganizationImage.objectKey,
				altText: OrganizationImage.altText,
			})
			.from(OrganizationImage)
			.where(eq(OrganizationImage.organizationId, organization.id))
			.limit(1)
			.then((rows) => rows[0] ?? null),
	])

	const [
		activeMigration,
		latestMigration,
		mediaFileCount,
		canDeleteOrganization,
	] = await Promise.all([
		getActiveStorageMigration(organization.id),
		getLatestStorageMigration(organization.id),
		countOrgMediaObjectKeys(organization.id),
		userIsOrganizationAdmin(userId, organization.id),
	])

	return {
		organization: { ...organizationFields, s3Config, image, domainClaim },
		activeMigration,
		latestMigration,
		mediaFileCount,
		canDeleteOrganization,
	}
}

const SettingsSchema = z.object({
	name: z.string().trim().min(1, 'Name is required'),
	slug: organizationSlugSchema,
})

/**
 * Org admins supply the S3 endpoint, and the server later fetches it (connection
 * test, uploads, migrations). Without this check it is an SSRF primitive into
 * the internal network / cloud metadata service. Dev keeps local MinIO usable.
 */
async function rejectUnsafeS3Endpoint(endpoint: string | null | undefined) {
	if (!endpoint || process.env.NODE_ENV !== 'production') return null
	const result = await validateInstanceUrlWithDns(endpoint)
	return result.valid ? null : (result.reason ?? 'Invalid S3 endpoint')
}

const EMAIL_DOMAIN_PATTERN =
	/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A lowercase, trimmed hostname, or null when it is not a plain domain. */
function normalizeEmailDomain(value: string) {
	const domain = value.trim().toLowerCase()
	return EMAIL_DOMAIN_PATTERN.test(domain) ? domain : null
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const [organization, user] = await Promise.all([
		requireUserOrganization(request, params.orgSlug, {
			id: true,
			name: true,
			slug: true,
			size: true,
			verifiedDomain: true,
			stripeSubscriptionId: true,
			dataRegion: true,
			hasProvisionedDb: true,
			customDomain: true,
		}),
		// Get user email for domain validation
		db
			.select({ email: User.email, name: User.name, username: User.username })
			.from(User)
			.where(eq(User.id, userId))
			.limit(1)
			.then((rows) => rows[0]),
	])

	if (!organization || !user) {
		throw new Response('Not Found', { status: 404 })
	}

	const adminOnlyIntents = [
		uploadOrgPhotoActionIntent,
		deleteOrgPhotoActionIntent,
		'update-settings',
		'update-team-size',
		'verified-domain',
		'check-verified-domain',
		'toggle-verified-domain',
		'delete-organization',
		s3StorageActionIntent,
		'test-s3-connection',
	]

	// Handle file uploads for organization logo
	const contentType = request.headers.get('content-type')
	if (contentType?.includes('multipart/form-data')) {
		const formData = await parseFormData(request, {
			maxFileSize: 1024 * 1024 * 3,
		})
		const intent = formData.get('intent')

		if (adminOnlyIntents.includes(intent as string)) {
			await requireUserWithOrganizationPermission(
				request,
				organization.id,
				ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
			)
		}

		if (intent === uploadOrgPhotoActionIntent) {
			const photoFile = formData.get('photoFile') as File
			if (!photoFile || !(photoFile instanceof File) || !photoFile.size) {
				return Response.json(
					{ error: 'A valid image file is required.' },
					{ status: 400 },
				)
			}

			try {
				const objectKey = await uploadOrganizationImage(
					organization.id,
					photoFile,
				)

				await db.transaction(async (tx) => {
					await tx
						.delete(OrganizationImage)
						.where(eq(OrganizationImage.organizationId, organization.id))
					await tx.insert(OrganizationImage).values({
						organizationId: organization.id,
						objectKey,
					})
				})

				await invalidateUserOrganizationsCache(userId)

				return Response.json({ status: 'success' })
			} catch (error) {
				console.error('Failed to upload organization logo:', error)
				return Response.json(
					{ error: 'Failed to upload organization logo' },
					{ status: 500 },
				)
			}
		}

		if (intent === deleteOrgPhotoActionIntent) {
			try {
				await db
					.delete(OrganizationImage)
					.where(eq(OrganizationImage.organizationId, organization.id))
				await invalidateUserOrganizationsCache(userId)
				return Response.json({ status: 'success' })
			} catch {
				return Response.json(
					{ error: 'Failed to delete organization logo' },
					{ status: 500 },
				)
			}
		}
	}

	// For non-multipart requests
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (adminOnlyIntents.includes(intent as string)) {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		)
	}

	if (intent === 'update-settings') {
		const submission = parseWithZod(formData, {
			schema: SettingsSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { name, slug } = submission.value

		try {
			await db
				.update(Organization)
				.set({ name, slug })
				.where(eq(Organization.id, organization.id))

			// Track onboarding step completion for completing profile
			// Check if organization now has both name and description (or just name for basic completion)
			try {
				await markStepCompleted(userId, organization.id, 'complete_profile', {
					completedVia: 'organization_settings_update',
					updatedFields: { name, slug },
				})
			} catch {
				// Don't fail the settings update if onboarding tracking fails
			}

			await invalidateUserOrganizationsCache(userId)

			return redirectWithToast(`/${slug}/settings`, {
				title: 'Organization updated',
				description: "Your organization's settings have been updated.",
				type: 'success',
			})
		} catch {
			return Response.json({
				result: submission.reply({
					formErrors: [
						'Failed to update organization settings. Please try again.',
					],
				}),
			})
		}
	}

	if (intent === 'update-team-size') {
		const submission = parseWithZod(formData, {
			schema: TeamSizeSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { size } = submission.value

		try {
			await db
				.update(Organization)
				.set({ size })
				.where(eq(Organization.id, organization.id))

			await invalidateUserOrganizationsCache(userId)

			return redirectWithToast(`/${organization.slug}/settings`, {
				title: 'Team size updated',
				description: 'Your organization team size has been updated.',
				type: 'success',
			})
		} catch {
			return Response.json({
				result: submission.reply({
					formErrors: ['Failed to update team size. Please try again.'],
				}),
			})
		}
	}

	if (intent === 'verified-domain') {
		const submission = parseWithZod(formData, {
			schema: VerifiedDomainSchema.superRefine((data, ctx) => {
				const domain = normalizeEmailDomain(data.verifiedDomain)
				if (!domain) {
					ctx.addIssue({
						path: ['verifiedDomain'],
						code: z.ZodIssueCode.custom,
						message: 'Enter a valid domain such as example.com.',
					})
					return
				}
				// Mailbox providers anyone can register on are never an organization.
				if (isPublicEmailDomain(domain)) {
					ctx.addIssue({
						path: ['verifiedDomain'],
						code: z.ZodIssueCode.custom,
						message: 'Email domain is not supported.',
					})
					return
				}

				// The caller must hold an address on the domain. This is not proof
				// that the organization owns the domain (no DNS check), so the
				// address itself must be mailbox-verified (see change-email).
				if (!user.email.toLowerCase().endsWith(`@${domain}`)) {
					ctx.addIssue({
						path: ['verifiedDomain'],
						code: z.ZodIssueCode.custom,
						message: `The domain provided does not match your email address domain. Please update your email to match the domain and try again.`,
					})
					return
				}
			}),
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		// Stored lowercase and trimmed: signup and discovery match it exactly.
		const domain = normalizeEmailDomain(
			submission.value.verifiedDomain,
		) as string
		if (await isDomainClaimedElsewhere(domain, organization.id)) {
			return Response.json({
				result: submission.reply({
					fieldErrors: {
						verifiedDomain: [
							'This domain is already verified by another organization.',
						],
					},
				}),
			})
		}
		// Nothing changes until the TXT record proves control of the domain.
		const claim = await startDomainClaim(organization.id, domain)
		return Response.json({
			result: submission.reply(),
			domainClaim: { domain, ...claim },
		})
	}

	if (intent === 'check-verified-domain') {
		const check = await checkDomainClaim(organization.id)
		if (check.status !== 'verified') {
			const message = {
				no_claim: 'Add a domain first.',
				not_found:
					'The TXT record was not found yet. DNS changes can take a few minutes; try again shortly.',
				taken: 'This domain is already verified by another organization.',
				lookup_failed: 'The DNS lookup failed. Please try again.',
			}[check.status]
			return Response.json({ domainCheck: { status: check.status, message } })
		}
		const { invited, more } = await inviteExistingDomainUsers({
			organizationId: organization.id,
			organizationName: organization.name,
			domain: check.domain,
			inviterId: userId,
			inviterName: user.name || user.username || organization.name,
			request,
		})
		await invalidateUserOrganizationsCache(userId)
		return redirectWithToast(`/${organization.slug}/settings`, {
			title: 'Domain verified',
			description: `${check.domain} is verified. ${invited} existing ${
				invited === 1 ? 'person was' : 'people were'
			} invited to join${more ? '; invite the rest from Members' : ''}. New sign-ups on this domain join automatically.`,
			type: 'success',
		})
	}

	if (intent === 'toggle-verified-domain') {
		try {
			await db
				.update(Organization)
				.set({
					verifiedDomain: null,
					verifiedDomainProvedAt: null,
					pendingVerifiedDomain: null,
					verifiedDomainToken: null,
				})
				.where(eq(Organization.id, organization.id))
			await invalidateUserOrganizationsCache(userId)
			return Response.json({ status: 'success' })
		} catch {
			return Response.json(
				{ error: 'Failed to remove verified domain' },
				{ status: 500 },
			)
		}
	}

	if (intent === 'delete-organization') {
		// Deleting cannot be undone, so it takes the built-in admin role, not
		// only a role that may change settings.
		await requireOrganizationAdmin(request, organization.id)

		// Customer data, staff records and call recordings live in the regional
		// tenant database, which the control-plane cascade cannot reach. Delete it
		// first (tenant-api still finds the organization by id), and keep the
		// organization if that fails so the deletion can be retried.
		// A database may exist even with the flag cleared (a failed region
		// switch), and deleting a missing one is a no-op, so always ask.
		const changedConcurrently = () =>
			Response.json(
				{
					error:
						'The organization was changed by someone else while it was being deleted. Reload the page and try again.',
				},
				{ status: 409 },
			)

		// Claim the organization before deleting anything. A region switch only
		// proceeds while the row is exactly as it read it, so this write (which
		// moves `updatedAt` forward) makes a concurrent switch stop, and a switch
		// that already moved the region makes this claim fail.
		const [claimed] = await db
			.update(Organization)
			.set({
				hasProvisionedDb: false,
				updatedAt: sql`max(${Organization.updatedAt} + 1, ${Date.now()})`,
			})
			.where(
				and(
					eq(Organization.id, organization.id),
					eq(Organization.dataRegion, organization.dataRegion),
					eq(Organization.hasProvisionedDb, organization.hasProvisionedDb),
				),
			)
			.returning({
				dataRegion: Organization.dataRegion,
				updatedAt: Organization.updatedAt,
			})
		if (!claimed) return changedConcurrently()
		const claimedAt = claimed.updatedAt
		const unchangedSinceClaim = and(
			eq(Organization.id, organization.id),
			eq(Organization.updatedAt, claimedAt),
		)
		// Give the flag back, unless someone else has written since the claim.
		const releaseClaim = () =>
			db
				.update(Organization)
				.set({ hasProvisionedDb: organization.hasProvisionedDb })
				.where(
					and(unchangedSinceClaim, eq(Organization.hasProvisionedDb, false)),
				)
				.catch(() => {})

		// The tenant wipe below cannot be undone, so first remove the rows whose
		// ON DELETE RESTRICT keys would make the Organization delete fail: SSO
		// sessions on this organization's SSO configurations (they hang off a
		// login session, not the organization) and invitations that use one of
		// its roles. Neither is worth keeping for an organization being deleted.
		try {
			const organizationRoleIds = db
				.select({ id: OrganizationRole.id })
				.from(OrganizationRole)
				.where(eq(OrganizationRole.organizationId, organization.id))
			await db.batch([
				db
					.delete(SSOSession)
					.where(
						inArray(
							SSOSession.ssoConfigId,
							db
								.select({ id: SSOConfiguration.id })
								.from(SSOConfiguration)
								.where(eq(SSOConfiguration.organizationId, organization.id)),
						),
					),
				db
					.delete(OrganizationInvitation)
					.where(
						or(
							eq(OrganizationInvitation.organizationId, organization.id),
							inArray(
								OrganizationInvitation.organizationRoleId,
								organizationRoleIds,
							),
						),
					),
			])
		} catch (error) {
			console.error('Failed to prepare the organization for deletion', {
				organizationId: organization.id,
				error: error instanceof Error ? error.message : String(error),
			})
			await releaseClaim()
			return Response.json(
				{ error: 'Failed to delete organization' },
				{ status: 500 },
			)
		}

		try {
			await deprovisionTenantDatabase({
				orgId: organization.id,
				dataRegion: claimed.dataRegion,
				slug: organization.slug,
				customDomain: organization.customDomain,
			})
		} catch (error) {
			console.error('Failed to delete the tenant database', {
				organizationId: organization.id,
				error: error instanceof Error ? error.message : String(error),
			})
			await releaseClaim()
			return Response.json(
				{
					error:
						"The organization's customer data could not be deleted, so the organization was not deleted. Try again in a few minutes.",
				},
				{ status: 502 },
			)
		}

		try {
			// Delete the organization - cascade deletes will handle all related
			// data. Only the row this request claimed: a region switch that wrote
			// since then may have provisioned a database this request did not wipe,
			// so the organization must stay to own it.
			const [deleted] = await db
				.delete(Organization)
				.where(unchangedSinceClaim)
				.returning({ id: Organization.id })
			if (!deleted) return changedConcurrently()

			// Cancel Stripe subscription if it exists
			if (organization.stripeSubscriptionId) {
				try {
					await deleteSubscription(organization.stripeSubscriptionId)
				} catch {
					// Don't fail the deletion if subscription cancellation fails
				}
			}

			await invalidateUserOrganizationsCache(userId)

			return redirectWithToast('/app', {
				title: 'Organization deleted',
				description: 'Your organization has been permanently deleted.',
				type: 'success',
			})
		} catch {
			return Response.json(
				{ error: 'Failed to delete organization' },
				{ status: 500 },
			)
		}
	}

	if (intent === startS3MigrationActionIntent) {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		)

		const [s3Config] = await db
			.select()
			.from(OrganizationS3Config)
			.where(eq(OrganizationS3Config.organizationId, organization.id))
			.limit(1)

		if (!s3Config?.isEnabled) {
			return redirectWithToast(`/${organization.slug}/settings`, {
				title: 'Migration unavailable',
				description: 'Enable custom S3 storage before migrating media files.',
				type: 'error',
			})
		}

		try {
			const dest = customSnapshotFromS3ConfigRow(s3Config)
			const plan = resolveStorageMigrationPlan({
				existingConfig: s3Config,
				dest,
			})
			if (!plan) {
				throw new Error('Your media is already in this bucket')
			}

			await createAndStartStorageMigration({
				organizationId: organization.id,
				...plan,
			})

			return redirectWithToast(`/${organization.slug}/settings`, {
				title: 'Storage migration started',
				description:
					'Copying existing org media to your bucket. Refresh this page for progress.',
				type: 'success',
			})
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Failed to start migration'
			return redirectWithToast(`/${organization.slug}/settings`, {
				title: 'Migration failed to start',
				description: message,
				type: 'error',
			})
		}
	}

	if (intent === s3StorageActionIntent) {
		const submission = parseWithZod(formData, {
			schema: S3StorageSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const {
			s3Enabled,
			s3MigrateExistingFiles,
			s3Endpoint,
			s3BucketName,
			s3AccessKeyId,
			s3SecretAccessKey,
			s3Region,
		} = submission.value

		// Disabling must always work, even for a config saved before this check.
		const unsafeEndpoint = s3Enabled
			? await rejectUnsafeS3Endpoint(s3Endpoint)
			: null
		if (unsafeEndpoint) {
			return Response.json({
				result: submission.reply({
					fieldErrors: { s3Endpoint: [unsafeEndpoint] },
				}),
			})
		}

		try {
			const [existingConfig] = await db
				.select()
				.from(OrganizationS3Config)
				.where(eq(OrganizationS3Config.organizationId, organization.id))
				.limit(1)

			const nextBucketSettings = {
				endpoint: s3Endpoint || '',
				bucketName: s3BucketName || '',
				accessKeyId: s3AccessKeyId || '',
				region: s3Region || '',
			}

			const bucketChanged = Boolean(
				existingConfig?.isEnabled &&
				s3Enabled &&
				s3BucketSettingsChanged(existingConfig, nextBucketSettings),
			)

			if (s3Enabled) {
				const secretToUse = s3SecretAccessKey
					? encrypt(s3SecretAccessKey, getSSOMasterKey())
					: existingConfig?.secretAccessKey || ''

				const previousSnapshot =
					bucketChanged && existingConfig
						? previousSnapshotFieldsFromConfig(existingConfig)
						: {}

				// Create or update S3 configuration
				await db
					.insert(OrganizationS3Config)
					.values({
						organizationId: organization.id,
						isEnabled: true,
						endpoint: nextBucketSettings.endpoint,
						bucketName: nextBucketSettings.bucketName,
						accessKeyId: nextBucketSettings.accessKeyId,
						secretAccessKey: secretToUse,
						region: nextBucketSettings.region,
						...previousSnapshot,
					})
					.onConflictDoUpdate({
						target: OrganizationS3Config.organizationId,
						set: {
							isEnabled: true,
							endpoint: nextBucketSettings.endpoint,
							bucketName: nextBucketSettings.bucketName,
							accessKeyId: nextBucketSettings.accessKeyId,
							secretAccessKey: secretToUse,
							region: nextBucketSettings.region,
							...previousSnapshot,
						},
					})
			} else {
				// Disable S3 configuration or delete it
				await db
					.insert(OrganizationS3Config)
					.values({
						organizationId: organization.id,
						isEnabled: false,
						endpoint: '',
						bucketName: '',
						accessKeyId: '',
						secretAccessKey: '',
						region: '',
					})
					.onConflictDoUpdate({
						target: OrganizationS3Config.organizationId,
						set: { isEnabled: false },
					})
			}

			if (s3Enabled && s3MigrateExistingFiles) {
				const destSecret =
					s3SecretAccessKey ||
					(existingConfig?.secretAccessKey
						? decrypt(existingConfig.secretAccessKey, getSSOMasterKey())
						: '')

				if (
					s3Endpoint &&
					s3BucketName &&
					s3AccessKeyId &&
					destSecret &&
					s3Region
				) {
					const dest = {
						endpoint: s3Endpoint,
						bucketName: s3BucketName,
						accessKeyId: s3AccessKeyId,
						secretAccessKey: destSecret,
						region: s3Region,
					}

					try {
						const plan = resolveStorageMigrationPlan({
							existingConfig,
							dest,
						})

						// null: only the credentials or region of the same
						// bucket changed, so the media is already in place.
						if (plan) {
							await createAndStartStorageMigration({
								organizationId: organization.id,
								...plan,
							})
						}
					} catch (error) {
						const message =
							error instanceof Error
								? error.message
								: 'Failed to start storage migration'
						return redirectWithToast(`/${organization.slug}/settings`, {
							title: 'S3 storage saved',
							description: `${message}. Your configuration was saved, but media was not migrated.`,
							type: 'message',
						})
					}
				}
			}

			await invalidateUserOrganizationsCache(userId)

			return redirectWithToast(`/${organization.slug}/settings`, {
				title: 'S3 Storage updated',
				description: s3Enabled
					? s3MigrateExistingFiles
						? 'Your S3 configuration was saved and media migration has started.'
						: 'Your custom S3 storage configuration has been saved.'
					: 'S3 storage has been disabled. Using default storage.',
				type: 'success',
			})
		} catch (error) {
			if (error instanceof Response) {
				throw error
			}
			console.error('s3StorageActionIntent error', error)
			return Response.json({
				result: submission.reply({
					formErrors: [
						'Failed to update S3 storage settings. Please try again.',
					],
				}),
			})
		}
	}

	if (intent === 'test-s3-connection') {
		const s3Endpoint = formData.get('s3Endpoint') as string
		const s3BucketName = formData.get('s3BucketName') as string
		const s3AccessKeyId = formData.get('s3AccessKeyId') as string
		const s3SecretAccessKey = formData.get('s3SecretAccessKey') as string
		const s3Region = formData.get('s3Region') as string

		if (
			!s3Endpoint ||
			!s3BucketName ||
			!s3AccessKeyId ||
			!s3SecretAccessKey ||
			!s3Region
		) {
			return Response.json({
				connectionTest: {
					success: false,
					message: 'All S3 configuration fields are required for testing.',
				},
			})
		}

		const unsafeEndpoint = await rejectUnsafeS3Endpoint(s3Endpoint)
		if (unsafeEndpoint) {
			return Response.json({
				connectionTest: { success: false, message: unsafeEndpoint },
			})
		}

		const config = {
			endpoint: s3Endpoint,
			bucket: s3BucketName,
			accessKey: s3AccessKeyId,
			secretKey: s3SecretAccessKey,
			region: s3Region,
		}

		const testResult = await testS3Connection(config)
		return Response.json({ connectionTest: testResult })
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function GeneralSettings() {
	const {
		organization,
		activeMigration,
		latestMigration,
		mediaFileCount,
		canDeleteOrganization,
	} = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()

	return (
		<AnnotatedLayout>
			{/* Identity: high-frequency profile fields + secondary team size */}
			<AnnotatedSection>
				<div className="flex flex-col gap-4">
					<GeneralSettingsCard organization={organization} />
					<TeamSizeCard organization={organization} actionData={actionData} />
				</div>
			</AnnotatedSection>

			{/* Access policy */}
			<AnnotatedSection>
				<VerifiedDomainCard
					organization={organization}
					actionData={actionData}
				/>
			</AnnotatedSection>

			{/* Infrastructure */}
			<AnnotatedSection>
				<S3StorageCard
					organization={organization}
					actionData={actionData}
					activeMigration={activeMigration}
					latestMigration={latestMigration}
					mediaFileCount={mediaFileCount}
				/>
			</AnnotatedSection>

			{/* Destructive — separated from routine settings. Only the built-in
			    admin role may delete the organization. */}
			{canDeleteOrganization ? (
				<section className="border-border mt-2 border-t pt-10">
					<DangerZoneCard organization={organization} />
				</section>
			) : null}
		</AnnotatedLayout>
	)
}
