/**
 * `media-src` entry for call recording playback. tenant-api signs links to
 * the bucket the voice worker writes to, and the browser plays them directly,
 * so the bucket's origin is built exactly as tenant-api builds the URL:
 * path-style on a custom endpoint, virtual-hosted on AWS.
 */
export function recordingMediaSrc(env: {
	RECORDING_S3_BUCKET?: string
	RECORDING_S3_ENDPOINT?: string
	RECORDING_S3_REGION?: string
}) {
	const bucket = env.RECORDING_S3_BUCKET
	if (!bucket) return []
	try {
		const url = env.RECORDING_S3_ENDPOINT
			? new URL(env.RECORDING_S3_ENDPOINT)
			: new URL(
					`https://${bucket}.s3.${env.RECORDING_S3_REGION || 'us-east-1'}.amazonaws.com`,
				)
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return []
		return [url.origin]
	} catch {
		return []
	}
}
