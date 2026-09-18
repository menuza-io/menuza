// Export all email templates
export { default as OrganizationInviteEmail } from './templates/organization-invite'
export { default as ContactTemplate } from './templates/contact'
export { default as InvoiceEmail } from './templates/invoice'
export { default as ForgotPasswordEmail } from './templates/forgot-password'
export { default as SignupEmail } from './templates/signup'
export { default as EmailChangeEmail } from './templates/email-change'
export { default as EmailChangeNoticeEmail } from './templates/email-change-notice'
export { default as TrialEndingEmail } from './templates/trial-ending'
export { default as NewDeviceSigninEmail } from './templates/new-device-signin'
export { default as MentionEmail } from './templates/mention-email'
export { default as CommentEmail } from './templates/comment-email'

// Export types
export type { OrganizationInviteEmailProps } from './templates/organization-invite'
export type { ContactTemplateProps } from './templates/contact'
export type { InvoiceEmailProps } from './templates/invoice'
export type { ForgotPasswordEmailProps } from './templates/forgot-password'
export type { SignupEmailProps } from './templates/signup'
export type { EmailChangeEmailProps } from './templates/email-change'
export type { EmailChangeNoticeEmailProps } from './templates/email-change-notice'
export type { TrialEndingEmailProps } from './templates/trial-ending'
export type { NewDeviceSigninEmailProps } from './templates/new-device-signin'
export type { MentionEmailProps } from './templates/mention-email'
export type { CommentEmailProps } from './templates/comment-email'

// Email theme tokens (mirror the app's shadcn design tokens)
export {
	emailBrandLogoSize,
	emailBrandLogoUrl,
	emailTailwindConfig,
	emailThemeColors,
} from './theme'

// Shared layout + element primitives used to compose transactional emails
export {
	EmailButton,
	EmailCard,
	EmailCode,
	EmailEyebrow,
	EmailField,
	EmailDetails,
	EmailHeading,
	EmailLayout,
	EmailLink,
	EmailNote,
	EmailParagraph,
	EmailQuote,
	EmailStep,
	EmailSteps,
	type EmailButtonProps,
	type EmailCardProps,
	type EmailCodeProps,
	type EmailEyebrowProps,
	type EmailFieldProps,
	type EmailDetailsProps,
	type EmailHeadingProps,
	type EmailLayoutProps,
	type EmailLinkProps,
	type EmailNoteProps,
	type EmailParagraphProps,
	type EmailQuoteProps,
	type EmailStepProps,
	type EmailStepsProps,
} from './components'

// Export sendEmail function (App/Admin — routes via EMAIL_PROVIDER)
export {
	sendEmail,
	type SendEmailInput,
	type SendEmailResult,
} from './send-email'
export {
	getEmailProvider,
	isOciEmailProvider,
	type EmailProvider,
} from './provider'
export {
	verifyResendWebhook,
	type ResendWebhookHeaders,
} from './resend-webhook'

// OCI Email Delivery (tenant-api regional marketing email + engagement)
export {
	createOciAuthProvider,
	fetchOciEngagementEvents,
	getOciEmailConfig,
	getOciEmailLogOcid,
	getOciMarketingMetrics,
	isOciEmailConfigured,
	isOciEngagementLoggingConfigured,
	parseOciEngagementLogRecord,
	resetOciEmailConfigCache,
	sendOciEmail,
	OCI_EMAIL_MOCK_SUBMIT_URL,
	shouldUseOciEmailMockTransport,
	type OciEmailConfig,
	type OciEngagementAction,
	type OciEngagementEvent,
	type OciMarketingMetrics,
	type SendOciEmailInput,
	type SendOciEmailResult,
} from './oci'
