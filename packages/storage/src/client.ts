import { createHash, createHmac } from 'crypto'
import { type FileUpload } from '@mjackson/form-data-parser'
import {
	type StorageConfig,
	type GetOrganizationConfigFn,
	type DecryptFn,
} from './types'

function hmacSha256(key: string | Buffer, message: string) {
	const hmac = createHmac('sha256', key)
	hmac.update(message)
	return hmac.digest()
}

function sha256(message: string) {
	const hash = createHash('sha256')
	hash.update(message)
	return hash.digest('hex')
}

function getSignatureKey(
	key: string,
	dateStamp: string,
	regionName: string,
	serviceName: string,
) {
	const kDate = hmacSha256(`AWS4${key}`, dateStamp)
	const kRegion = hmacSha256(kDate, regionName)
	const kService = hmacSha256(kRegion, serviceName)
	const kSigning = hmacSha256(kService, 'aws4_request')
	return kSigning
}

function encodeObjectKey(key: string) {
	return key
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/')
}

function getBaseSignedRequestInfo({
	method,
	key,
	contentType,
	uploadDate,
	config,
}: {
	method: 'GET' | 'HEAD' | 'PUT' | 'DELETE'
	key: string
	contentType?: string
	uploadDate?: string
	config: StorageConfig
}) {
	const encodedKey = encodeObjectKey(key)
	const url = `${config.endpoint}/${config.bucket}/${encodedKey}`
	const endpoint = new URL(url)

	// Prepare date strings
	const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)

	// Build headers array conditionally
	const headers = [
		...(contentType ? [`content-type:${contentType}`] : []),
		`host:${endpoint.host}`,
		`x-amz-content-sha256:UNSIGNED-PAYLOAD`,
		`x-amz-date:${amzDate}`,
		...(uploadDate ? [`x-amz-meta-upload-date:${uploadDate}`] : []),
	]

	const canonicalHeaders = headers.join('\n') + '\n'
	const signedHeaders = headers.map((h) => h.split(':')[0]).join(';')

	const canonicalRequest = [
		method,
		`/${config.bucket}/${encodedKey}`,
		'', // canonicalQueryString
		canonicalHeaders,
		signedHeaders,
		'UNSIGNED-PAYLOAD',
	].join('\n')

	// Prepare string to sign
	const algorithm = 'AWS4-HMAC-SHA256'
	const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`
	const stringToSign = [
		algorithm,
		amzDate,
		credentialScope,
		sha256(canonicalRequest),
	].join('\n')

	// Calculate signature
	const signingKey = getSignatureKey(
		config.secretKey,
		dateStamp,
		config.region,
		's3',
	)
	const signature = createHmac('sha256', signingKey)
		.update(stringToSign)
		.digest('hex')

	const baseHeaders = {
		'X-Amz-Date': amzDate,
		'X-Amz-Content-SHA256': 'UNSIGNED-PAYLOAD',
		Authorization: [
			`${algorithm} Credential=${config.accessKey}/${credentialScope}`,
			`SignedHeaders=${signedHeaders}`,
			`Signature=${signature}`,
		].join(', '),
	}

	return { url, baseHeaders }
}

function getSignedPutRequestInfo(
	file: File | FileUpload,
	key: string,
	config: StorageConfig,
) {
	const uploadDate = new Date().toISOString()
	const { url, baseHeaders } = getBaseSignedRequestInfo({
		method: 'PUT',
		key,
		contentType: file.type,
		uploadDate,
		config,
	})

	return {
		url,
		headers: {
			...baseHeaders,
			'Content-Type': file.type,
			'X-Amz-Meta-Upload-Date': uploadDate,
		},
	}
}

export function getSignedDeleteRequestInfo(key: string, config: StorageConfig) {
	const { url, baseHeaders } = getBaseSignedRequestInfo({
		method: 'DELETE',
		key,
		config,
	})

	return {
		url,
		headers: baseHeaders,
	}
}

/**
 * Get signed GET request info synchronously (uses default config only)
 */
export function getSignedGetRequestInfo(key: string, config: StorageConfig) {
	const { url, baseHeaders } = getBaseSignedRequestInfo({
		method: 'GET',
		key,
		config,
	})

	return {
		url,
		headers: baseHeaders,
	}
}

export function getSignedPutRequestInfoForKey(
	key: string,
	config: StorageConfig,
	contentType: string,
) {
	const { url, baseHeaders } = getBaseSignedRequestInfo({
		method: 'PUT',
		key,
		contentType,
		config,
	})

	return {
		url,
		headers: {
			...baseHeaders,
			'Content-Type': contentType,
		},
	}
}

export function getSignedHeadRequestInfo(key: string, config: StorageConfig) {
	const { url, baseHeaders } = getBaseSignedRequestInfo({
		method: 'HEAD',
		key,
		config,
	})

	return {
		url,
		headers: baseHeaders,
	}
}

/**
 * Get signed GET request info asynchronously (supports org-specific config)
 */
export async function getSignedGetRequestInfoAsync(
	key: string,
	config: StorageConfig,
) {
	const { url, baseHeaders } = getBaseSignedRequestInfo({
		method: 'GET',
		key,
		config,
	})

	return {
		url,
		headers: baseHeaders,
	}
}

function buildCanonicalQueryString(params: Array<[string, string]>): string {
	return params
		.sort(([a], [b]) => a.localeCompare(b))
		.map(
			([key, value]) =>
				`${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
		)
		.join('&')
}

/**
 * Build a query-string presigned GET URL (SigV4).
 * Useful when a client must fetch without custom Authorization headers.
 */
export function getPresignedGetUrl(
	key: string,
	config: StorageConfig,
	expiresInSeconds = 3600,
) {
	const encodedKey = encodeObjectKey(key)
	const endpoint = new URL(`${config.endpoint}/${config.bucket}/${encodedKey}`)
	const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)
	const algorithm = 'AWS4-HMAC-SHA256'
	const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`
	const canonicalQueryString = buildCanonicalQueryString([
		['X-Amz-Algorithm', algorithm],
		['X-Amz-Credential', `${config.accessKey}/${credentialScope}`],
		['X-Amz-Date', amzDate],
		['X-Amz-Expires', String(expiresInSeconds)],
		['X-Amz-SignedHeaders', 'host'],
	])
	const canonicalHeaders = `host:${endpoint.host}\n`
	const signedHeaders = 'host'
	const canonicalRequest = [
		'GET',
		`/${config.bucket}/${encodedKey}`,
		canonicalQueryString,
		canonicalHeaders,
		signedHeaders,
		'UNSIGNED-PAYLOAD',
	].join('\n')
	const stringToSign = [
		algorithm,
		amzDate,
		credentialScope,
		sha256(canonicalRequest),
	].join('\n')
	const signingKey = getSignatureKey(
		config.secretKey,
		dateStamp,
		config.region,
		's3',
	)
	const signature = createHmac('sha256', signingKey)
		.update(stringToSign)
		.digest('hex')

	const url = new URL(endpoint.toString())
	url.search = `${canonicalQueryString}&X-Amz-Signature=${signature}`

	return url.toString()
}

/**
 * Build a query-string presigned PUT URL (SigV4).
 */
export function getPresignedPutUrl(
	key: string,
	config: StorageConfig,
	contentType: string,
	expiresInSeconds = 3600,
) {
	const encodedKey = encodeObjectKey(key)
	const endpoint = new URL(`${config.endpoint}/${config.bucket}/${encodedKey}`)
	const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)
	const algorithm = 'AWS4-HMAC-SHA256'
	const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`
	const canonicalQueryString = buildCanonicalQueryString([
		['X-Amz-Algorithm', algorithm],
		['X-Amz-Credential', `${config.accessKey}/${credentialScope}`],
		['X-Amz-Date', amzDate],
		['X-Amz-Expires', String(expiresInSeconds)],
		['X-Amz-SignedHeaders', 'content-type;host'],
	])
	const canonicalHeaders = `content-type:${contentType}\nhost:${endpoint.host}\n`
	const signedHeaders = 'content-type;host'
	const canonicalRequest = [
		'PUT',
		`/${config.bucket}/${encodedKey}`,
		canonicalQueryString,
		canonicalHeaders,
		signedHeaders,
		'UNSIGNED-PAYLOAD',
	].join('\n')
	const stringToSign = [
		algorithm,
		amzDate,
		credentialScope,
		sha256(canonicalRequest),
	].join('\n')
	const signingKey = getSignatureKey(
		config.secretKey,
		dateStamp,
		config.region,
		's3',
	)
	const signature = createHmac('sha256', signingKey)
		.update(stringToSign)
		.digest('hex')

	const url = new URL(endpoint.toString())
	url.search = `${canonicalQueryString}&X-Amz-Signature=${signature}`

	return url.toString()
}

/**
 * Upload a file to S3-compatible storage
 */
export async function uploadToStorage(
	file: File | FileUpload,
	key: string,
	config: StorageConfig,
) {
	const { url, headers } = getSignedPutRequestInfo(file, key, config)

	const uploadResponse = await fetch(url, {
		method: 'PUT',
		headers,
		body: file instanceof File ? file : file.stream(),
	})

	if (!uploadResponse.ok) {
		const errorMessage = `Failed to upload file to storage. Server responded with ${uploadResponse.status}: ${uploadResponse.statusText}`
		console.error(errorMessage)
		throw new Error(`Failed to upload object: ${key}`)
	}

	return key
}

/**
 * Delete a file from S3-compatible storage
 */
export async function deleteFromStorage(
	key: string,
	config: StorageConfig,
): Promise<void> {
	const { url, headers } = getSignedDeleteRequestInfo(key, config)
	const response = await fetch(url, {
		method: 'DELETE',
		headers,
	})

	if (!response.ok && response.status !== 404) {
		const errorMessage = `Failed to delete file from storage. Server responded with ${response.status}: ${response.statusText}`
		console.error(errorMessage)
		throw new Error(`Failed to delete object: ${key}`)
	}
}

/**
 * Test S3 connection by uploading and deleting a test file
 */
export async function testS3Connection(
	config: StorageConfig,
): Promise<{ success: boolean; message?: string }> {
	try {
		const testKey = `test-connection-${Date.now()}.txt`
		const testFile = new File(['test'], 'test.txt', { type: 'text/plain' })

		const { url, headers } = getSignedPutRequestInfo(testFile, testKey, config)

		const response = await fetch(url, {
			method: 'PUT',
			headers,
			body: testFile,
		})

		if (response.ok) {
			// Try to delete the test file with proper signing
			try {
				const { url: deleteUrl, headers: deleteHeaders } =
					getSignedDeleteRequestInfo(testKey, config)
				await fetch(deleteUrl, { method: 'DELETE', headers: deleteHeaders })
			} catch {
				// Ignore delete errors - test file will remain in bucket
			}

			return {
				success: true,
				message:
					'Successfully connected to S3 bucket and verified write permissions.',
			}
		} else {
			return {
				success: false,
				message: `Failed to upload test file: ${response.status} ${response.statusText}`,
			}
		}
	} catch (error) {
		return {
			success: false,
			message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
		}
	}
}

/**
 * Create a storage client with default configuration
 */
export function createStorageClient(defaultConfig: StorageConfig) {
	return {
		/**
		 * Get storage configuration, optionally for a specific organization
		 */
		async getConfig(
			organizationId?: string,
			options?: {
				getOrganizationConfig?: GetOrganizationConfigFn
				decrypt?: DecryptFn
			},
		): Promise<StorageConfig> {
			// If organization ID is provided and config retrieval function exists
			if (
				organizationId &&
				options?.getOrganizationConfig &&
				options?.decrypt
			) {
				const s3Config = await options.getOrganizationConfig(organizationId)

				// If organization has S3 enabled, use custom config
				if (s3Config?.isEnabled) {
					return {
						endpoint: s3Config.endpoint,
						bucket: s3Config.bucketName,
						accessKey: s3Config.accessKeyId,
						secretKey: options.decrypt(s3Config.secretAccessKey),
						region: s3Config.region,
					}
				}
			}

			// Fall back to default configuration
			return defaultConfig
		},

		/**
		 * Upload a file to storage
		 */
		async upload(
			file: File | FileUpload,
			key: string,
			organizationId?: string,
			options?: {
				getOrganizationConfig?: GetOrganizationConfigFn
				decrypt?: DecryptFn
			},
		) {
			const config = await this.getConfig(organizationId, options)
			return uploadToStorage(file, key, config)
		},

		/**
		 * Get signed GET request info
		 */
		async getSignedGetUrl(
			key: string,
			organizationId?: string,
			options?: {
				getOrganizationConfig?: GetOrganizationConfigFn
				decrypt?: DecryptFn
			},
		) {
			const config = await this.getConfig(organizationId, options)
			return getSignedGetRequestInfoAsync(key, config)
		},

		/**
		 * Test connection to storage
		 */
		async testConnection(
			organizationId?: string,
			options?: {
				getOrganizationConfig?: GetOrganizationConfigFn
				decrypt?: DecryptFn
			},
		) {
			const config = await this.getConfig(organizationId, options)
			return testS3Connection(config)
		},
	}
}
