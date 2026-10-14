import { Trans } from '@lingui/macro'
import { type ReportDefinition } from '@repo/reports'
import { ReportVisualization, useReportRunner } from '@repo/reports/ui'
import { useMemo } from 'react'
import {
	isReportAccessDenied,
	ORGANIZATION_REPORT_CATALOG,
	type ReportBlockData,
} from '#app/utils/dashboards/reports.ts'
import { ReportBlockMessage } from './report-block-message.tsx'
import { useReportStateMessages } from './use-report-state-messages.ts'

/**
 * Runs a report the way the reports page does: control-plane subjects
 * through the App's run route, customer data straight from the browser to
 * the regional tenant-api with a short-lived token.
 */
export function ReportBlockResult({
	definition,
	reports,
}: {
	definition: ReportDefinition
	reports: ReportBlockData
}) {
	// Every reload of the page data brings a new but equal definition, which
	// must not run the report again.
	const definitionKey = JSON.stringify(definition)
	const stableDefinition = useMemo(
		() => JSON.parse(definitionKey) as ReportDefinition,
		[definitionKey],
	)
	const { result, error, loading } = useReportRunner({
		catalog: ORGANIZATION_REPORT_CATALOG,
		definition: stableDefinition,
		controlPlaneRunUrl: reports.runUrl,
		tenantTokenUrl: reports.tokenUrl,
		tenantApiUrl: reports.tenantApiUrl,
	})
	const messages = useReportStateMessages()

	if (isReportAccessDenied(error)) {
		return (
			<ReportBlockMessage icon="lock" title={<Trans>No access</Trans>}>
				<Trans>You don't have permission to see this report's data.</Trans>
			</ReportBlockMessage>
		)
	}

	return (
		<ReportVisualization
			compact
			definition={stableDefinition}
			result={result}
			error={error}
			// The report only starts after mounting; until then it is loading too.
			loading={loading || (!result && !error)}
			messages={messages}
		/>
	)
}
