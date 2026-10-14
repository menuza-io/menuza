import { describe, expect, it } from 'vitest'
import { recordingMediaSrc } from './recording-csp.ts'

describe('recordingMediaSrc', () => {
	it('allows the custom endpoint origin for path-style buckets', () => {
		expect(
			recordingMediaSrc({
				RECORDING_S3_BUCKET: 'recordings',
				RECORDING_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
			}),
		).toEqual(['https://acct.r2.cloudflarestorage.com'])
	})

	it('allows the virtual-hosted AWS origin', () => {
		expect(
			recordingMediaSrc({
				RECORDING_S3_BUCKET: 'recs',
				RECORDING_S3_REGION: 'us-east-2',
			}),
		).toEqual(['https://recs.s3.us-east-2.amazonaws.com'])
	})

	it('allows nothing without a bucket or with a bad endpoint', () => {
		expect(recordingMediaSrc({})).toEqual([])
		expect(
			recordingMediaSrc({
				RECORDING_S3_BUCKET: 'recordings',
				RECORDING_S3_ENDPOINT: 'not a url',
			}),
		).toEqual([])
		expect(
			recordingMediaSrc({
				RECORDING_S3_BUCKET: 'recordings',
				RECORDING_S3_ENDPOINT: 'javascript:alert(1)',
			}),
		).toEqual([])
	})
})
