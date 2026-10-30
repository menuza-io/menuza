# Print shop: Canva

Operators who design in Canva can bring a finished design into the Print shop
(**Import from Canva**) and print it as a poster, flyer or any product that may
go without a QR code. The other way round, a template print can be opened in
Canva as a new Canva design (**Send to Canva**) to change it freely there.

Each member connects their own Canva account (Canva Connect, OAuth with PKCE).
The App reads only the designs that member picks; nothing is synced in the
background.

## Turning it on

| Flag / variable                            | Effect                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `print_shop.canva` (org flag, default off) | Import from Canva and Send to Canva (needs the master) |
| `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET`  | The Canva Connect integration. Empty: the buttons hide |
| `CANVA_MOCK=true` (local only)             | A Canva emulator with three sample designs, no keys    |
| `INTEGRATION_ENCRYPTION_KEY` (already set) | Encrypts the stored Canva tokens                       |

The Canva pages need the campaign write permission (`update:campaign:any`), like
creating a print. Members who can only read prints do not see the buttons and
get a 403 from the routes.

`CANVA_MOCK` is ignored unless `BASE_URL` is a local host (`localhost`,
`127.0.0.1`, `*.test`, `*.localhost`), so a stray value in production does
nothing. Playwright sets it.

## Setting up the Canva integration

1. In the [Canva developer portal](https://www.canva.com/developers/), create a
   **Connect API** integration (public, so members of any Canva team can
   connect).
2. Scopes: `design:meta:read`, `design:content:read`, `design:content:write`,
   `profile:read`. Nothing else is asked for.
3. Authentication, redirect URL: `<BASE_URL>/resources/print/canva/callback`
   (one per environment: staging and production each have their own integration
   or their own redirect URL).
4. Copy the client ID and generate a client secret; set `CANVA_CLIENT_ID` and
   `CANVA_CLIENT_SECRET` on the App (the secret is sensitive).
5. Submit the integration for Canva's review before turning the flag on for
   customers. Until it is approved, only the developer's own Canva team can use
   it.

## How it works

```text
Connect     POST /:org/marketing/print/canva/connect  (PKCE + signed state cookie;
              a plain GET only goes back to the Import from Canva page)
              └─▶ Canva consent ─▶ /resources/print/canva/callback
                    checks: same browser (cookie), same signed-in user, state,
                    then print write access and the flag; code ─▶ tokens
Import      /:org/marketing/print/canva  (pick a design, product, size, name)
              ├─ GET /designs/{id}              title, pages
              ├─ POST /exports pdf (pro, page 1) ─▶ poll ─▶ download (≤ 40 MB)
              │    a design with paid elements the plan cannot export falls
              │    back to regular quality
              ├─ POST /exports png (page 1)     proof preview
              ├─ page size check (below)
              └─ platform bucket print/<org>/artwork/<hash>/print.pdf|preview.png
                    ─▶ PrintDesign (source 'artwork', artwork JSON, draft)
Update      the same Canva design again ─▶ new file, back to draft
Edit        a fresh edit link (Canva's links last 30 days) in a new tab
Send        the template print's PDF (3 mm bleed) ─▶ POST /imports ─▶ new Canva
            design owned by the member ─▶ its edit link in a new tab
```

An imported print (an **artwork** print) is a finished file. The proof shows the
exported page, and downloads, approval and shipped orders use the stored PDF as
it is: there is no template, no QR code and no per-language copy. Only its name
changes in the editor. Approve it like any print before downloading or ordering
it.

### Page size

The first page of the Canva design must be the print's size, give or take 2 mm,
with or without an even bleed of up to 6 mm on every side (Canva: File,
Settings, Show print bleed, then export with bleed). A square social post
imported as an A3 poster is refused with a message that says what to change. The
size is read by walking the PDF's page tree to its first page (`/MediaBox`
inherited from parent nodes, `/Rotate` applied), never from the first box found
in the file. Objects packed in compressed object streams (PDF 1.5+) are read
too. A file whose size still cannot be read is refused ("Canva's file could not
be read"): a thumbnail's shape cannot tell A4 from A3, nor show a bleed. The
recorded bleed is at most 6 mm (half a millimetre over is point rounding).

Only page 1 prints. A design with more pages imports with a note saying so.
Without bleed the editor notes that a colour running to the edge can show a thin
white line after cutting. Shipped prints send the file as it is: Prodigi fills
the print area from it (`fillPrintArea`), so a bleed other than the vendor's is
trimmed or scaled. Place a sandbox order of an artwork print per vendor before
launch.

### Codes that are capabilities

A vertical's QR codes can be capabilities (its `canView` rule). A print that
carries such codes is never sent to Canva: the codes would leave the App and
live on in the member's Canva account. Sending is refused with a message.

## Tokens and privacy

- Tokens live in `PrintCanvaConnection` (one row per organization and member),
  encrypted with `INTEGRATION_ENCRYPTION_KEY`, and never reach the browser.
- Canva refresh tokens are single use. A refresh writes the new pair only if the
  stored refresh token is still the one used, so two requests refreshing at once
  keep the winner's tokens. Only Canva's `invalid_grant` answer (revoked in
  Canva, or expired) deletes the connection and asks the member to connect
  again; any other token error leaves it in place.
- When Canva refuses an access token, the work is retried once after a refresh,
  except for Send to Canva: an import may already have made a design, so the
  member is asked to try again instead.
- **Disconnect Canva** deletes the row and revokes the grant at Canva (best
  effort). Prints already imported stay.
- The connection is per organization: a member of two organizations connects in
  each. Deleting the user or the organization deletes it; a member who leaves
  the organization keeps an unused row until then, and the Print shop routes
  refuse them anyway.
- Canva thumbnails are fetched by the App server and inlined in the picker (the
  App's CSP loads no third-party images). Download links from Canva must be
  https on `canva.com` or one of its subdomains (each redirect is checked the
  same way, at most three), and are time-limited and size-capped. Previews must
  carry PNG bytes.
- Imported files hold whatever the operator designed in Canva. They are the
  organization's marketing material, kept in the platform bucket next to the
  rendered PDFs. Files are stored by content hash, so designs with identical
  bytes share one file; nothing deletes print files today, and any cleanup must
  check every design and order that refers to a key first.

## Limits

- Canva rate limits: exports 20 requests per minute per user, design reads 100
  per minute. A limit shows as "Canva asked us to slow down".
- Export and import jobs are polled for up to 90 seconds.
- Imported PDFs: 40 MB at most. Titles sent to Canva: 50 characters.
- Autofill (filling a Canva brand template with the organization's data) needs a
  paid Canva plan on the member's side and is not used: table cards and other
  prints with codes stay on the templates.

## Testing

- Unit: `apps/app/app/utils/print/canva/*.test.ts` (OAuth, polling, errors,
  downloads, PDF size, token rotation) and
  `apps/app/app/utils/print/artwork.server.test.ts` (import, size check, update,
  send, private codes).
- E2E: `apps/app/tests/e2e/print-shop-canva.test.ts` against the emulator.
- Locally: set `CANVA_MOCK=true` in `apps/app/.env`, turn on
  `print_shop.enabled` and `print_shop.canva` for the organization in Admin,
  then Marketing, Print shop, Import from Canva.
