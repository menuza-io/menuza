/**
 * Isomorphic React Email components for marketing emails.
 *
 * This entry must stay free of server-only imports (resend / oci) so the app
 * editor can render the exact same blocks client-side for its live preview.
 */
export {
	EmailBlocks,
	EmailBlockView,
	type EmailBlockViewProps,
} from './components/blocks.tsx'
export { blocksToPlainText } from './blocks-to-text.ts'
export {
	DEFAULT_UNSUBSCRIBE_TEXT,
	EmailBody,
	type EmailBodyProps,
	type EmailSocialLink,
} from './components/email-body.tsx'
export {
	EmailDocument,
	type EmailDocumentProps,
} from './components/email-document.tsx'
