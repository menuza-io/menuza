import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/** What an operator is told when importing or sending to Canva fails. */
export const PRINT_ARTWORK_ERROR_LABELS: Record<string, MessageDescriptor> = {
	canva_not_connected: msg`Connect Canva again: the connection has expired or was removed in Canva.`,
	canva_unavailable: msg`Canva did not answer. Try again in a minute.`,
	canva_rate_limited: msg`Canva asked us to slow down. Try again in a minute.`,
	canva_license: msg`This design uses paid Canva elements that your Canva plan cannot export.`,
	canva_not_found: msg`That design is not in your Canva account anymore.`,
	artwork_product: msg`This print cannot be made from a finished design.`,
	artwork_size: msg`The design's page is not the size of the print. In Canva, make the page the same size as the print (bleed is fine), then import it again.`,
	artwork_too_large: msg`The design's PDF is larger than 40 MB.`,
	artwork_unreadable: msg`Canva's file could not be read. Try again, or open the design in Canva and save it again.`,
	codes_private: msg`This print carries private QR codes, so it cannot be sent to Canva.`,
	renderer_missing: msg`Sending to Canva needs PDF rendering, which is not set up here.`,
	render_limited: msg`Your organization made many new print files this hour. Try again in about 15 minutes.`,
	render_failed: msg`The print file could not be made. Try again shortly.`,
}

export const PRINT_ARTWORK_ERROR_FALLBACK = msg`That did not work. Try again.`
