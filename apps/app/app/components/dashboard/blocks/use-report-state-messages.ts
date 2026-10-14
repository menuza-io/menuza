import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ReportRunError } from '@repo/reports'
import { type ReportStateMessages } from '@repo/reports/ui'

// Run errors carry English messages from the runner, the run route or the
// tenant-api, so what a block says is chosen by the error code instead.
function runErrorMessage(error: ReportRunError | string): MessageDescriptor {
	const code: string | null = typeof error === 'string' ? null : error.error
	switch (code) {
		case 'invalid_definition':
		case 'unknown_subject':
			return msg`Its settings are not valid. Open the report to check them.`
		case 'tenant_not_provisioned':
			return msg`This organization does not have a customer database yet.`
		case 'shop_not_available':
			return msg`Shop order reports are only available for US organizations.`
		default:
			return msg`Its results could not be loaded. Try again later.`
	}
}

/** The texts of a report block's states without a result, translated. */
export function useReportStateMessages(): ReportStateMessages {
	const { _ } = useLingui()
	return {
		loading: _(msg`Loading results…`),
		errorTitle: _(msg`Cannot run this report`),
		errorBody: (error) => _(runErrorMessage(error)),
		missingGroupTitle: _(msg`Missing required segmentation field`),
		missingGroupBody: _(
			msg`Open the report and choose a field to group its results by.`,
		),
		configureTitle: _(msg`Configure the report`),
		configureBody: _(
			msg`Choose a subject and timeframe to see a live visualization.`,
		),
		noMatchesTitle: _(msg`No matching records`),
		noMatchesBody: _(
			msg`Nothing in this timeframe matches the report's filters.`,
		),
	}
}
