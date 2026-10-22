import {
	getFormProps,
	getInputProps,
	useForm,
	useInputControl,
} from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { StatusButton } from '@repo/ui/status-button'
import { Switch as ShadcnSwitch } from '@repo/ui/switch'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'
import { useConformSaveBar } from '#app/components/save-bar.tsx'

export const S3StorageSchema = z
	.object({
		intent: z.string().optional(),
		s3Enabled: z.boolean().default(false),
		s3MigrateExistingFiles: z.boolean().optional(),
		s3Endpoint: z.string().url().optional().or(z.literal('')),
		s3BucketName: z
			.string()
			.min(1, 'Bucket name is required')
			.optional()
			.or(z.literal('')),
		s3AccessKeyId: z
			.string()
			.min(1, 'Access Key ID is required')
			.optional()
			.or(z.literal('')),
		s3SecretAccessKey: z.string().optional().or(z.literal('')), // Made optional for updates
		s3Region: z
			.string()
			.min(1, 'Region is required')
			.optional()
			.or(z.literal('')),
	})
	.refine(
		(data) => {
			if (data.s3Enabled) {
				return (
					data.s3Endpoint &&
					data.s3BucketName &&
					data.s3AccessKeyId &&
					data.s3Region
				)
			}
			return true
		},
		{
			message:
				'S3 endpoint, bucket name, access key ID, and region are required when S3 storage is enabled',
			path: ['s3Enabled'],
		},
	)

export const s3StorageActionIntent = 'update-s3-storage'
export const startS3MigrationActionIntent = 'start-s3-migration'

interface StorageMigrationStatus {
	id: string
	status: string
	totalObjects: number
	processedObjects: number
	failedObjects: number
	lastError: string | null
}

interface Organization {
	id: string
	s3Config?: {
		id: string
		isEnabled: boolean
		endpoint: string
		bucketName: string
		accessKeyId: string
		secretAccessKey: string
		region: string
	} | null
}

type SwitchProps = {
	formId: string
	id?: string
	name: string
	value?: string
	defaultChecked?: boolean
	['aria-describedby']?: string
}

function Switch({
	name,
	formId,
	value,
	defaultChecked,
	...props
}: SwitchProps) {
	const control = useInputControl({
		formId,
		key: props.id,
		name,
		// Match the form's default, or the form starts dirty.
		initialValue: value ?? (defaultChecked ? 'on' : ''),
	})

	return (
		<>
			<input type="hidden" name={name} value={control.value ?? ''} />
			<ShadcnSwitch
				{...props}
				name={undefined}
				checked={control.value === 'on'}
				onCheckedChange={(checked) => control.change(checked ? 'on' : '')}
				onBlur={() => control.blur()}
			/>
		</>
	)
}

export function S3StorageCard({
	organization,
	actionData,
	activeMigration,
	latestMigration,
	mediaFileCount,
}: {
	organization: Organization
	actionData?: any
	activeMigration?: StorageMigrationStatus | null
	latestMigration?: StorageMigrationStatus | null
	mediaFileCount: number
}) {
	const fetcher = useFetcher()
	const migrationFetcher = useFetcher()

	const [form, fields] = useForm({
		id: 's3-storage-form',
		constraint: getZodConstraint(S3StorageSchema),
		lastResult: actionData?.result || fetcher.data?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: S3StorageSchema })
		},
		// Hidden inputs belong in the defaults, or Conform reports the form dirty.
		defaultValue: {
			intent: s3StorageActionIntent,
			s3Enabled: organization.s3Config?.isEnabled ? 'on' : '',
			s3Endpoint: organization.s3Config?.endpoint || '',
			s3BucketName: organization.s3Config?.bucketName || '',
			s3AccessKeyId: organization.s3Config?.accessKeyId || '',
			s3SecretAccessKey: '', // Always empty for security - require re-entry
			s3Region: organization.s3Config?.region || '',
		},
	})

	useConformSaveBar(form, fetcher)

	const testConnectionFetcher = useFetcher()
	const migration = activeMigration ?? latestMigration
	const migrationInProgress =
		activeMigration?.status === 'pending' ||
		activeMigration?.status === 'running'
	const canStartMigration =
		organization.s3Config?.isEnabled &&
		mediaFileCount > 0 &&
		!migrationInProgress

	const processedObjects = migration?.processedObjects ?? 0
	const totalObjects = migration?.totalObjects ?? 0
	const failedObjects = migration?.failedObjects ?? 0
	const failedObjectsText =
		failedObjects > 0 ? ` (${failedObjects} failed)` : ''

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Icon name="database" className="h-5 w-5" />
					<Trans>S3 Storage Configuration</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="space-y-4">
					<fetcher.Form
						method="POST"
						{...getFormProps(form)}
						className="space-y-4"
					>
						<input type="hidden" name="intent" value={s3StorageActionIntent} />
						<div className="flex items-center justify-between">
							<div className="space-y-1">
								<Label className="flex items-center gap-2">
									<Switch
										formId={form.id}
										id={fields.s3Enabled.id}
										name={fields.s3Enabled.name}
										defaultChecked={organization.s3Config?.isEnabled}
									/>
									<Trans>Enable Custom S3 Storage</Trans>
								</Label>
								<p className="text-muted-foreground text-sm">
									<Trans>
										Use your own S3-compatible storage instead of the default
										storage
									</Trans>
								</p>
							</div>
						</div>

						{(fields.s3Enabled.value === 'on' ||
							organization.s3Config?.isEnabled) && (
							<div className="space-y-4 border-t pt-4">
								<div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950">
									<div className="flex gap-3">
										<Icon
											name="alert-triangle"
											className="h-5 w-5 shrink-0 self-start text-yellow-800 dark:text-yellow-200"
										/>
										<div className="text-sm">
											<p className="font-medium text-yellow-800 dark:text-yellow-200">
												<Trans>Important Security Note</Trans>
											</p>
											<p className="mt-1 text-yellow-700 dark:text-yellow-400">
												<Trans>
													Your S3 credentials will be encrypted and stored
													securely. However, we recommend using IAM credentials
													with minimal required permissions (read/write access
													to the specific bucket only).
												</Trans>
											</p>
										</div>
									</div>
								</div>

								<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
									<Field
										labelProps={{
											htmlFor: fields.s3Endpoint.id,
											children: <Trans>S3 Endpoint URL</Trans>,
										}}
										inputProps={{
											...getInputProps(fields.s3Endpoint, { type: 'url' }),
											placeholder: 'https://s3.amazonaws.com',
										}}
										errors={fields.s3Endpoint.errors}
									/>
									<Field
										labelProps={{
											htmlFor: fields.s3Region.id,
											children: <Trans>Region</Trans>,
										}}
										inputProps={{
											...getInputProps(fields.s3Region, { type: 'text' }),
											placeholder: 'us-east-1',
										}}
										errors={fields.s3Region.errors}
									/>
								</div>

								<Field
									labelProps={{
										htmlFor: fields.s3BucketName.id,
										children: <Trans>Bucket Name</Trans>,
									}}
									inputProps={{
										...getInputProps(fields.s3BucketName, { type: 'text' }),
										placeholder: 'my-organization-bucket',
									}}
									errors={fields.s3BucketName.errors}
								/>

								<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
									<Field
										labelProps={{
											htmlFor: fields.s3AccessKeyId.id,
											children: <Trans>Access Key ID</Trans>,
										}}
										inputProps={{
											...getInputProps(fields.s3AccessKeyId, { type: 'text' }),
											placeholder: 'AKIAIOSFODNN7EXAMPLE',
										}}
										errors={fields.s3AccessKeyId.errors}
									/>
									<Field
										labelProps={{
											htmlFor: fields.s3SecretAccessKey.id,
											children: <Trans>Secret Access Key</Trans>,
										}}
										inputProps={{
											...getInputProps(fields.s3SecretAccessKey, {
												type: 'password',
											}),
											placeholder: organization.s3Config?.secretAccessKey
												? '••••••••••••••••••••••••••••••••••••••••••'
												: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
										}}
										errors={fields.s3SecretAccessKey.errors}
									/>
									{organization.s3Config?.secretAccessKey && (
										<p className="text-muted-foreground mt-1 text-sm">
											<Trans>
												Leave empty to keep existing secret key, or enter a new
												one to update.
											</Trans>
										</p>
									)}
								</div>

								{mediaFileCount > 0 ? (
									<div className="rounded-lg border p-4">
										<Label className="flex items-start gap-2">
											<input
												type="checkbox"
												name="s3MigrateExistingFiles"
												value="on"
												className="mt-1"
											/>
											<span className="space-y-1">
												<span className="block font-medium">
													<Trans>Migrate existing org media after saving</Trans>
												</span>
												<span className="text-muted-foreground block text-sm">
													<Trans>
														Copy {mediaFileCount} note and comment media files
														from the previous storage location into this bucket.
													</Trans>
												</span>
											</span>
										</Label>
									</div>
								) : null}

								<ErrorList id={form.errorId} errors={form.errors} />
							</div>
						)}
					</fetcher.Form>
				</div>

				{migration ? (
					<div className="rounded-lg border p-4">
						<p className="font-medium">
							<Trans>Storage migration</Trans>{' '}
							<span className="text-muted-foreground text-sm capitalize">
								({migration.status})
							</span>
						</p>
						<p className="text-muted-foreground mt-1 text-sm">
							<Trans>
								{processedObjects} of {totalObjects} files copied
								{failedObjectsText}
							</Trans>
						</p>
						{migration.lastError ? (
							<p className="mt-2 text-sm text-red-600">{migration.lastError}</p>
						) : null}
					</div>
				) : null}
			</CardContent>
			<CardFooter className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
				{canStartMigration ? (
					<migrationFetcher.Form method="POST" className="contents">
						<input
							type="hidden"
							name="intent"
							value={startS3MigrationActionIntent}
						/>
						<StatusButton
							type="submit"
							variant="outline"
							size="sm"
							status={migrationFetcher.state !== 'idle' ? 'pending' : 'idle'}
						>
							<Icon name="refresh-cw" className="mr-1 h-4 w-4" />
							<Trans>Migrate existing media</Trans>
						</StatusButton>
					</migrationFetcher.Form>
				) : null}
				{fields.s3Endpoint.value &&
					fields.s3BucketName.value &&
					fields.s3AccessKeyId.value &&
					fields.s3SecretAccessKey.value &&
					fields.s3Region.value && (
						<testConnectionFetcher.Form method="POST" className="contents">
							<input type="hidden" name="intent" value="test-s3-connection" />
							<input
								type="hidden"
								name="s3Endpoint"
								value={fields.s3Endpoint.value}
							/>
							<input
								type="hidden"
								name="s3BucketName"
								value={fields.s3BucketName.value}
							/>
							<input
								type="hidden"
								name="s3AccessKeyId"
								value={fields.s3AccessKeyId.value}
							/>
							<input
								type="hidden"
								name="s3SecretAccessKey"
								value={fields.s3SecretAccessKey.value}
							/>
							<input
								type="hidden"
								name="s3Region"
								value={fields.s3Region.value}
							/>
							<StatusButton
								type="submit"
								variant="outline"
								size="sm"
								status={
									testConnectionFetcher.state !== 'idle' ? 'pending' : 'idle'
								}
							>
								<Icon name="link-2" className="mr-1 h-4 w-4" />
								Test Connection
							</StatusButton>
						</testConnectionFetcher.Form>
					)}
				{testConnectionFetcher.data?.connectionTest ? (
					<div
						className={`w-full rounded-lg border p-3 ${
							testConnectionFetcher.data.connectionTest.success
								? 'border-green-200 bg-green-50'
								: 'border-red-200 bg-red-50'
						}`}
					>
						<div className="flex items-center gap-2">
							<Icon
								name={
									testConnectionFetcher.data.connectionTest.success
										? 'check'
										: 'x'
								}
								className={`h-4 w-4 ${
									testConnectionFetcher.data.connectionTest.success
										? 'text-green-600'
										: 'text-red-600'
								}`}
							/>
							<p
								className={`text-sm font-medium ${
									testConnectionFetcher.data.connectionTest.success
										? 'text-green-800'
										: 'text-red-800'
								}`}
							>
								{testConnectionFetcher.data.connectionTest.success
									? 'Connection successful!'
									: 'Connection failed'}
							</p>
						</div>
						{testConnectionFetcher.data.connectionTest.message ? (
							<p
								className={`mt-1 text-sm ${
									testConnectionFetcher.data.connectionTest.success
										? 'text-green-700'
										: 'text-red-700'
								}`}
							>
								{testConnectionFetcher.data.connectionTest.message}
							</p>
						) : null}
					</div>
				) : null}
			</CardFooter>
		</Card>
	)
}
