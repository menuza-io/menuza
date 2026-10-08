import type { TenantOrg } from './tenant-org.ts'
import type { TenantRegistry } from './tenant-registry.ts'

export interface TenantApiWorkerEnv {
	TENANT_ORG: DurableObjectNamespace<TenantOrg>
	TENANT_REGISTRY: DurableObjectNamespace<TenantRegistry>
	TENANT_API_RUNTIME?: string
	DATA_REGION: string
	NODE_ENV?: string
	APP_URL: string
	ROOT_APP: string
	GLOBAL_SMS_CAP?: string
	TWILIO_ACCOUNT_SID?: string
	TWILIO_FROM_NUMBER?: string
	JWT_SECRET: string
	AUTH_HMAC_SECRET: string
	INTERNAL_COMMAND_TOKEN: string
	TENANT_OPERATOR_TOKEN: string
	VOICE_AGENT_TOKEN?: string
	RECORDING_S3_BUCKET?: string
	RECORDING_S3_REGION?: string
	RECORDING_S3_ENDPOINT?: string
	RECORDING_S3_ACCESS_KEY?: string
	RECORDING_S3_SECRET?: string
	TWILIO_AUTH_TOKEN?: string
	OCI_TENANCY_OCID?: string
	OCI_USER_OCID?: string
	OCI_FINGERPRINT?: string
	OCI_PRIVATE_KEY?: string
	OCI_REGION?: string
	OCI_EMAIL_COMPARTMENT_ID?: string
	OCI_EMAIL_SENDER_EMAIL?: string
	OCI_EMAIL_SENDER_NAME?: string
	OCI_EMAIL_SENDER_OCID?: string
	OCI_EMAIL_LOG_OCID?: string
}
