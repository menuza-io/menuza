/**
 * Oracle Cloud Email Delivery provider.
 *
 * Used by tenant-api for regional customer marketing email. App/Admin continue
 * to use Resend via sendEmail().
 */

export {
	createOciAuthProvider,
	getOciEmailConfig,
	getOciEmailLogOcid,
	isOciEmailConfigured,
	resetOciEmailConfigCache,
	type OciEmailConfig,
} from './config.ts'

export {
	sendOciEmail,
	type SendOciEmailInput,
	type SendOciEmailResult,
} from './send-oci-email.ts'

export {
	OCI_EMAIL_MOCK_SUBMIT_URL,
	shouldUseOciEmailMockTransport,
} from './mock-transport.ts'

export { getOciMarketingMetrics, type OciMarketingMetrics } from './metrics.ts'

export {
	fetchOciEngagementEvents,
	isOciEngagementLoggingConfigured,
	parseOciEngagementLogRecord,
	type OciEngagementAction,
	type OciEngagementEvent,
} from './engagement-logs.ts'
export {
	dkimSelectorFor,
	getEmailDomainProvider,
	getMockEmailDomainProvider,
	MockEmailDomainProvider,
	OciEmailDomainProvider,
	setEmailDomainProvider,
	type EmailDomainCheck,
	type EmailDomainProvider,
	type EmailDomainRecord,
	type EmailDomainRecordPurpose,
	type EmailDomainRegistration,
	type EmailDomainStatus,
} from './email-domain.ts'
