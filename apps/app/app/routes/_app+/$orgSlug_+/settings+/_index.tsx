import { parseWithZod } from '@conform-to/zod'
import { parseFormData } from '@mjackson/form-data-parser'
import { requireUserId } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'
import { markStepCompleted } from '@repo/common/onboarding'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	db,
	eq,
	isNull,
	like,
	Organization,
	OrganizationImage,
	OrganizationRole,
	OrganizationS3Config,
	User,
	UserOrganization,
} from '@repo/database'
import { decrypt, encrypt, getSSOMasterKey } from '@repo/security'
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
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import {
	updateSeatQuantity,
	deleteSubscription,
} from '#app/utils/payments.server.ts'
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
	await requireUserId(request)

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		size: true,
		verifiedDomain: true,
		stripeSubscriptionId: true,
	})

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
			.then((rows) => rows[0] ?? null),
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

	const [activeMigration, latestMigration, mediaFileCount] = await Promise.all([
		getActiveStorageMigration(organization.id),
		getLatestStorageMigration(organization.id),
		countOrgMediaObjectKeys(organization.id),
	])

	return {
		organization: { ...organization, s3Config, image },
		activeMigration,
		latestMigration,
		mediaFileCount,
	}
}

const SettingsSchema = z.object({
	name: z.string().min(1, 'Name is required'),
	slug: z.string().min(1, 'Slug is required'),
})

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
		}),
		// Get user email for domain validation
		db
			.select({ email: User.email })
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
				if (data.verifiedDomain) {
					// Block common domains
					if (
						[
							'gmail.com',
							'yahoo.com',
							'hotmail.com',
							'outlook.com',
							'icloud.com',
						].includes(data.verifiedDomain)
					) {
						ctx.addIssue({
							path: ['verifiedDomain'],
							code: z.ZodIssueCode.custom,
							message: 'Email domain is not supported.',
						})
						return
					}

					// Check if user's email domain matches the verified domain
					if (!user.email.endsWith(`@${data.verifiedDomain}`)) {
						ctx.addIssue({
							path: ['verifiedDomain'],
							code: z.ZodIssueCode.custom,
							message: `The domain provided does not match your email address domain. Please update your email to match the domain and try again.`,
						})
						return
					}
				}
			}),
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { verifiedDomain } = submission.value

		try {
			await db.transaction(async (tx) => {
				// Update the organization with the verified domain
				await tx
					.update(Organization)
					.set({ verifiedDomain })
					.where(eq(Organization.id, organization.id))

				// Find all users with emails ending with this domain who are not already members
				const usersWithMatchingDomain = await tx
					.select({ id: User.id, email: User.email, name: User.name })
					.from(User)
					.leftJoin(
						UserOrganization,
						and(
							eq(UserOrganization.userId, User.id),
							eq(UserOrganization.organizationId, organization.id),
						),
					)
					.where(
						and(
							like(User.email, `%@${verifiedDomain}`),
							isNull(UserOrganization.userId),
						),
					)

				// Auto-add these users to the organization
				if (usersWithMatchingDomain.length > 0) {
					// Get the member role first
					const [memberRole] = await tx
						.select({ id: OrganizationRole.id })
						.from(OrganizationRole)
						.where(eq(OrganizationRole.name, 'member'))
						.limit(1)

					if (!memberRole) {
						throw new Error('Member role not found')
					}

					await tx.insert(UserOrganization).values(
						usersWithMatchingDomain.map((user) => ({
							userId: user.id,
							organizationId: organization.id,
							organizationRoleId: memberRole.id,
						})),
					)
				}

				// Update seat quantity for billing if users were added
				if (usersWithMatchingDomain.length > 0) {
					try {
						await updateSeatQuantity(organization.id)
					} catch {
						// Failed to update seat quantity
					}
				}
			})

			await invalidateUserOrganizationsCache(userId)

			return redirectWithToast(`/${organization.slug}/settings`, {
				title: 'Verified domain updated',
				description:
					'Your organization verified domain has been updated and matching users have been automatically added.',
				type: 'success',
			})
		} catch {
			return Response.json({
				result: submission.reply({
					formErrors: ['Failed to update verified domain. Please try again.'],
				}),
			})
		}
	}

	if (intent === 'toggle-verified-domain') {
		try {
			await db
				.update(Organization)
				.set({ verifiedDomain: null })
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
		try {
			// Cancel Stripe subscription if it exists
			if (organization.stripeSubscriptionId) {
				try {
					await deleteSubscription(organization.stripeSubscriptionId)
				} catch {
					// Don't fail the deletion if subscription cancellation fails
				}
			}

			// Delete the organization - cascade deletes will handle all related data
			await db.delete(Organization).where(eq(Organization.id, organization.id))

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

						await createAndStartStorageMigration({
							organizationId: organization.id,
							...plan,
						})
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
	const { organization, activeMigration, latestMigration, mediaFileCount } =
		useLoaderData<typeof loader>()
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

			{/* Destructive — separated from routine settings */}
			<section className="border-border mt-2 border-t pt-10">
				<DangerZoneCard organization={organization} />
			</section>
		</AnnotatedLayout>
	)
}
