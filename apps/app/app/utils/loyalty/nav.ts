import { type LoyaltyFeatures, type LoyaltyPermission } from '@repo/loyalty'
import {
	canSeeLoyaltySection,
	LOYALTY_SECTIONS,
	type LoyaltySectionDefinition,
} from './sections.ts'

/** Which links of the sidebar "Loyalty" group the current member should see. */
export type LoyaltyNavAccess = {
	visible: boolean
	overview: boolean
	program: boolean
	rewards: boolean
	activity: boolean
}

export const HIDDEN_LOYALTY_NAV: LoyaltyNavAccess = {
	visible: false,
	overview: false,
	program: false,
	rewards: false,
	activity: false,
}

export function computeLoyaltyNavAccess(
	features: LoyaltyFeatures,
	grants: ReadonlySet<string> | readonly LoyaltyPermission[],
): LoyaltyNavAccess {
	if (!features.enabled) return HIDDEN_LOYALTY_NAV
	const overview = canSeeLoyaltySection('overview', features, grants)
	const program = canSeeLoyaltySection('program', features, grants)
	const rewards = canSeeLoyaltySection('rewards', features, grants)
	const activity = canSeeLoyaltySection('activity', features, grants)
	return {
		visible: overview || program || rewards || activity,
		overview,
		program,
		rewards,
		activity,
	}
}

export function visibleLoyaltySections(
	features: LoyaltyFeatures,
	grants: ReadonlySet<string> | readonly LoyaltyPermission[],
): LoyaltySectionDefinition[] {
	return LOYALTY_SECTIONS.filter((section) =>
		canSeeLoyaltySection(section.id, features, grants),
	)
}

export function firstVisibleLoyaltyPath(
	orgSlug: string,
	features: LoyaltyFeatures,
	grants: ReadonlySet<string> | readonly LoyaltyPermission[],
): string | null {
	const visible = visibleLoyaltySections(features, grants)
	if (visible.length === 0) return null
	return `/${orgSlug}/loyalty/${visible[0]!.path}`
}
