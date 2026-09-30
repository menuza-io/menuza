import {
	and,
	asc,
	count,
	db,
	eq,
	inArray,
	Integration,
	isNotNull,
	OnboardingProgress,
	OnboardingStep,
	OnboardingStepProgress,
	Organization,
	OrganizationInvitation,
	OrganizationNote,
	UserOrganization,
} from '@repo/database'
import { POS_PROVIDER_NAMES } from './pos-providers.ts'

async function countRows(table: any, condition: any): Promise<number> {
	const [row] = await db.select({ value: count() }).from(table).where(condition)
	return row?.value ?? 0
}

export interface OnboardingStepAction {
	type: 'navigate' | 'modal' | 'external'
	target: string
	label: string
	completedLabel?: string
}

export interface OnboardingStepDetectConfig {
	condition: string
	params?: Record<string, any>
}

export interface OnboardingStepWithProgress {
	id: string
	key: string
	title: string
	description: string
	icon?: string
	actionConfig?: OnboardingStepAction
	detectConfig?: OnboardingStepDetectConfig
	sortOrder: number
	isCompleted: boolean
	completedAt?: Date
}

export interface OnboardingProgressData {
	totalSteps: number
	completedCount: number
	isCompleted: boolean
	isVisible: boolean
	steps: OnboardingStepWithProgress[]
}

// Get onboarding progress for a user in an organization
export async function getOnboardingProgress(
	userId: string,
	organizationId: string,
): Promise<OnboardingProgressData> {
	// Get all active onboarding steps
	const steps = await db
		.select()
		.from(OnboardingStep)
		.where(eq(OnboardingStep.isActive, true))
		.orderBy(asc(OnboardingStep.sortOrder))
	const progressRows = await db
		.select()
		.from(OnboardingStepProgress)
		.where(
			and(
				eq(OnboardingStepProgress.userId, userId),
				eq(OnboardingStepProgress.organizationId, organizationId),
			),
		)

	// If no onboarding steps exist (e.g., database not seeded), return empty progress
	if (steps.length === 0) {
		return {
			totalSteps: 0,
			completedCount: 0,
			isCompleted: true, // Mark as completed so onboarding doesn't show
			isVisible: false,
			steps: [],
		}
	}

	// Get or create overall progress record
	let progress
	try {
		const [existingProgress] = await db
			.insert(OnboardingProgress)
			.values({
				userId,
				organizationId,
				totalSteps: steps.length,
				completedCount: 0,
				isCompleted: false,
			})
			.onConflictDoUpdate({
				target: [OnboardingProgress.userId, OnboardingProgress.organizationId],
				set: { totalSteps: steps.length },
			})
			.returning()
		progress = existingProgress
	} catch (error: any) {
		// Only log if it's not a P2003 (foreign key constraint) error
		// P2003 typically means the User or Organization was deleted concurrently during tests
		if (
			error?.code !== 'P2003' &&
			!(
				error instanceof Error &&
				error.message.includes('Foreign key constraint')
			)
		) {
			console.error('Error upserting onboarding progress:', error)
		}
		// Return safe default if foreign key constraint fails - show onboarding if steps exist
		return {
			totalSteps: steps.length,
			completedCount: 0,
			isCompleted: false, // Don't mark as completed so onboarding shows
			isVisible: true, // Make it visible so onboarding shows
			steps: steps.map((step: any) => ({
				id: step.id,
				key: step.key,
				title: step.title,
				description: step.description,
				icon: step.icon || undefined,
				actionConfig: step.actionConfig
					? (JSON.parse(step.actionConfig) as OnboardingStepAction)
					: undefined,
				detectConfig: step.detectConfig
					? (JSON.parse(step.detectConfig) as OnboardingStepDetectConfig)
					: undefined,
				sortOrder: step.sortOrder,
				isCompleted: false,
				completedAt: undefined,
			})),
		}
	}

	// Transform steps with progress data
	const stepsWithProgress: OnboardingStepWithProgress[] = steps.map(
		(step: any) => {
			const userProgress = progressRows.find(
				(progress) => progress.stepId === step.id,
			)
			return {
				id: step.id,
				key: step.key,
				title: step.title,
				description: step.description,
				icon: step.icon || undefined,
				actionConfig: step.actionConfig
					? (JSON.parse(step.actionConfig) as OnboardingStepAction)
					: undefined,
				detectConfig: step.detectConfig
					? (JSON.parse(step.detectConfig) as OnboardingStepDetectConfig)
					: undefined,
				sortOrder: step.sortOrder,
				isCompleted: userProgress?.isCompleted || false,
				completedAt: userProgress?.completedAt || undefined,
			}
		},
	)

	const completedCount = stepsWithProgress.filter(
		(step) => step.isCompleted,
	).length

	return {
		totalSteps: steps.length,
		completedCount,
		isCompleted: completedCount === steps.length,
		isVisible: progress?.isVisible ?? true,
		steps: stepsWithProgress,
	}
}

// Mark a step as completed
export async function markStepCompleted(
	userId: string,
	organizationId: string,
	stepKey: string,
	metadata?: Record<string, any>,
) {
	try {
		const [step] = await db
			.select()
			.from(OnboardingStep)
			.where(eq(OnboardingStep.key, stepKey))
			.limit(1)

		if (!step) {
			throw new Error(`Onboarding step '${stepKey}' not found`)
		}

		// Create or update step progress
		await db
			.insert(OnboardingStepProgress)
			.values({
				userId,
				organizationId,
				stepId: step.id,
				isCompleted: true,
				completedAt: new Date(),
				metadata: metadata ? JSON.stringify(metadata) : null,
			})
			.onConflictDoUpdate({
				target: [
					OnboardingStepProgress.userId,
					OnboardingStepProgress.organizationId,
					OnboardingStepProgress.stepId,
				],
				set: {
					isCompleted: true,
					completedAt: new Date(),
					metadata: metadata ? JSON.stringify(metadata) : null,
				},
			})

		// Update overall progress
		const [completedRow] = await db
			.select({ value: count() })
			.from(OnboardingStepProgress)
			.where(
				and(
					eq(OnboardingStepProgress.userId, userId),
					eq(OnboardingStepProgress.organizationId, organizationId),
					eq(OnboardingStepProgress.isCompleted, true),
				),
			)
		const [totalRow] = await db
			.select({ value: count() })
			.from(OnboardingStep)
			.where(eq(OnboardingStep.isActive, true))
		const completedCount = completedRow?.value ?? 0
		const totalSteps = totalRow?.value ?? 0

		const isCompleted = completedCount === totalSteps

		await db
			.insert(OnboardingProgress)
			.values({
				userId,
				organizationId,
				completedCount,
				totalSteps,
				isCompleted,
				completedAt: isCompleted ? new Date() : null,
			})
			.onConflictDoUpdate({
				target: [OnboardingProgress.userId, OnboardingProgress.organizationId],
				set: {
					completedCount,
					totalSteps,
					isCompleted,
					completedAt: isCompleted ? new Date() : null,
				},
			})
	} catch (error: any) {
		// Log the error but don't throw it to prevent breaking the main flow

		// If it's a unique constraint error, it means the record already exists, which is fine
		if (error instanceof Error && error.message.includes('Unique constraint')) {
			console.log(
				`Onboarding step ${stepKey} already completed for user ${userId} in organization ${organizationId}`,
			)
			return
		}

		// If it's a foreign key constraint error, it typically means the User or Organization
		// was deleted concurrently (very common in tests with teardown blocks).
		if (
			error?.code === 'P2003' ||
			(error instanceof Error &&
				error.message.includes('Foreign key constraint'))
		) {
			return
		}

		// For other errors, we still don't want to break the main flow
		console.error(
			`Failed to mark onboarding step ${stepKey} as completed:`,
			error,
		)
	}
}

// Hide onboarding for a user
export async function hideOnboarding(userId: string, organizationId: string) {
	try {
		await db
			.insert(OnboardingProgress)
			.values({
				userId,
				organizationId,
				isVisible: false,
				totalSteps: 0,
				completedCount: 0,
				isCompleted: false,
			})
			.onConflictDoUpdate({
				target: [OnboardingProgress.userId, OnboardingProgress.organizationId],
				set: { isVisible: false },
			})
	} catch (error: any) {
		// Ignore foreign key constraint errors during test teardowns
		if (
			error?.code === 'P2003' ||
			(error instanceof Error &&
				error.message.includes('Foreign key constraint'))
		) {
			return
		}
		console.error('Failed to hide onboarding:', error)
	}
}

// Auto-detect completed steps based on user data
export async function autoDetectCompletedSteps(
	userId: string,
	organizationId: string,
) {
	try {
		// Get steps that have auto-detection enabled
		const stepsWithDetection = await db
			.select()
			.from(OnboardingStep)
			.where(
				and(
					eq(OnboardingStep.isActive, true),
					eq(OnboardingStep.autoDetect, true),
					isNotNull(OnboardingStep.detectConfig),
				),
			)

		// If no onboarding steps exist, skip auto-detection
		if (stepsWithDetection.length === 0) {
			return
		}

		// Get detection data
		const detectionData = await getDetectionData(userId, organizationId)

		for (const step of stepsWithDetection) {
			if (!step.detectConfig) continue

			try {
				const detectConfig = JSON.parse(
					step.detectConfig,
				) as OnboardingStepDetectConfig
				const isCompleted = evaluateDetectionCondition(
					detectConfig.condition,
					detectionData,
				)

				if (isCompleted) {
					// Check if already marked as completed
					const [existingProgress] = await db
						.select()
						.from(OnboardingStepProgress)
						.where(
							and(
								eq(OnboardingStepProgress.userId, userId),
								eq(OnboardingStepProgress.organizationId, organizationId),
								eq(OnboardingStepProgress.stepId, step.id),
							),
						)
						.limit(1)

					if (!existingProgress?.isCompleted) {
						await markStepCompleted(userId, organizationId, step.key, {
							autoDetected: true,
						})
					}
				}
			} catch (error) {
				console.error(`Error auto-detecting step ${step.key}:`, error)
			}
		}
	} catch (error) {
		console.error('Error in autoDetectCompletedSteps:', error)
		// Fail silently to avoid breaking the app
		return
	}
}

// Get data needed for auto-detection
async function getDetectionData(userId: string, organizationId: string) {
	const [
		notesCount,
		membersCount,
		organization,
		integrationsCount,
		posIntegrationsCount,
		invitationsCount,
	] = await Promise.all([
		countRows(
			OrganizationNote,
			and(
				eq(OrganizationNote.organizationId, organizationId),
				eq(OrganizationNote.createdById, userId),
			),
		),
		countRows(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		),
		db
			.select({
				name: Organization.name,
				slug: Organization.slug,
				createdAt: Organization.createdAt,
			})
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)
			.then(([row]) => row),
		countRows(
			Integration,
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.isActive, true),
			),
		),
		countRows(
			Integration,
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.isActive, true),
				inArray(Integration.providerName, POS_PROVIDER_NAMES),
			),
		),
		countRows(
			OrganizationInvitation,
			and(
				eq(OrganizationInvitation.organizationId, organizationId),
				eq(OrganizationInvitation.inviterId, userId),
			),
		),
	])

	// Check if user has used AI chat by looking at onboarding step completion
	const [aiChatStep] = await db
		.select({ id: OnboardingStepProgress.id })
		.from(OnboardingStepProgress)
		.innerJoin(
			OnboardingStep,
			eq(OnboardingStepProgress.stepId, OnboardingStep.id),
		)
		.where(
			and(
				eq(OnboardingStepProgress.userId, userId),
				eq(OnboardingStepProgress.organizationId, organizationId),
				eq(OnboardingStep.key, 'try_ai_chat'),
				eq(OnboardingStepProgress.isCompleted, true),
			),
		)
		.limit(1)

	// Check if user has used command menu by looking at onboarding step completion
	const [commandMenuStep] = await db
		.select({ id: OnboardingStepProgress.id })
		.from(OnboardingStepProgress)
		.innerJoin(
			OnboardingStep,
			eq(OnboardingStepProgress.stepId, OnboardingStep.id),
		)
		.where(
			and(
				eq(OnboardingStepProgress.userId, userId),
				eq(OnboardingStepProgress.organizationId, organizationId),
				eq(OnboardingStep.key, 'explore_command_menu'),
				eq(OnboardingStepProgress.isCompleted, true),
			),
		)
		.limit(1)

	return {
		hasNotes: notesCount > 0,
		hasMembersInvited: membersCount > 1 || invitationsCount > 0, // Has other members OR has sent invitations
		hasCompletedProfile: !!(
			organization?.name &&
			organization?.name.trim() !== '' &&
			organization?.slug &&
			organization?.slug.trim() !== ''
		),
		hasUsedAiChat: !!aiChatStep,
		hasUsedCommandMenu: !!commandMenuStep,
		hasIntegrations: integrationsCount > 0,
		hasPosIntegration: posIntegrationsCount > 0,
	}
}

// Evaluate detection conditions
function evaluateDetectionCondition(
	condition: string,
	data: Record<string, any>,
): boolean {
	switch (condition) {
		case 'hasNotes':
			return data.hasNotes
		case 'hasMembersInvited':
			return data.hasMembersInvited
		case 'hasCompletedProfile':
			return data.hasCompletedProfile
		case 'hasUsedAiChat':
			return data.hasUsedAiChat
		case 'hasUsedCommandMenu':
			return data.hasUsedCommandMenu
		case 'hasIntegrations':
			return data.hasIntegrations
		case 'hasPosIntegration':
			return data.hasPosIntegration
		default:
			return false
	}
}

export {
	handleOnboardingProgress,
	handleOnboardingHide,
	handleOnboardingCompleteStep,
	type OnboardingProgressDependencies,
	type OnboardingHideDependencies,
	type OnboardingCompleteStepDependencies,
} from './onboarding/route-handlers'
