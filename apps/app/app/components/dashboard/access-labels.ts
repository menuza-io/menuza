import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type DashboardShareAccess } from '#app/utils/dashboards/config.ts'

/** How recipients see the access a dashboard was shared with. */
export const SHARED_ACCESS_LABELS: Record<
	DashboardShareAccess,
	MessageDescriptor
> = {
	view: msg`View only`,
	edit: msg`Can edit`,
}

/** The access levels the owner picks from when sharing. */
export const SHARE_ACCESS_OPTIONS: Record<
	DashboardShareAccess,
	MessageDescriptor
> = {
	view: msg`View`,
	edit: msg`Edit`,
}
