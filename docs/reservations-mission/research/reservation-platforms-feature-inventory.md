# Reservation platforms: feature inventory

Scope: OpenTable (restaurant side: GuestCenter / OpenTable for Restaurants,
plans Basic / Core / Pro, plus Connect and Private Dining; diner side: website,
app, widget), Resy / ResyOS (now combined with Tock under American Express),
SevenRooms (a DoorDash company), Tock, Yelp Guest Manager (+ Yelp Host AI
phone), Toast Tables, and Reserve with Google (Google Actions Center,
Reservations End-to-End).

Method: web search only (search-result titles and snippets). FetchUrl was not
used, so many vendor help pages (Salesforce-hosted OpenTable support) returned
only short snippets. Facts confirmed by a snippet are marked **[S]**. Other
items are well-known product behavior from public product pages and industry
knowledge, and are unmarked; the "Notes and uncertainties" section lists items
that need verification.

Tier legend:

- **TS** = table stakes (any credible reservation system needs it)
- **Core** = expected for OpenTable-like parity
- **Adv** = advanced / differentiator

Competitor abbreviations: OT = OpenTable, RY = Resy/ResyOS, 7R = SevenRooms, TK
= Tock, YG = Yelp Guest Manager, TT = Toast Tables, RwG = Reserve with Google.

## Sources consulted (titles + URLs from search results)

OpenTable (restaurant side)

- Core Plan - Pricing & Features | OpenTable for Restaurants -
  https://www.opentable.com/restaurant-solutions/plans/core/
- Basic Plan | OpenTable for Restaurants -
  https://www.opentable.com/restaurant-solutions/plans/basic/
- OpenTable Pro | OpenTable for Restaurants -
  https://www.opentable.com/restaurant-solutions/plans/pro/
- Plans & Pricing | OpenTable for Restaurants -
  https://restaurant.opentable.com/products/ and
  https://www.opentable.com/restaurant-solutions/plans/
- Affordable Restaurant Reservation System (Connect) -
  https://www.opentable.com/restaurant-solutions/products/connect/
- Private Event Management & Group Booking Software -
  https://www.opentable.com/restaurant-solutions/plans/private-dining/
- Set up Event Management for your restaurant (Request space) -
  https://support.opentable.com/s/article/Showcase-Your-Private-Dining-Space
- Customize your availability, schedule, and shift settings -
  https://support.opentable.com/s/article/Advanced-availability-setup-in-GuestCenter
- Flow controls - https://support.opentable.com/s/article/flow-controls
- Configure turn times - https://support.opentable.com/s/article/turn-times
- Set turn controls for high volume shifts -
  https://support.opentable.com/s/article/turn-controls
- Manage Availability Planning settings and rules (Access rules, large party) -
  https://support.opentable.com/s/article/Online-Availability-Settings
- Availability Planning Glossary -
  https://support.opentable.com/s/article/apglossary
- Create and manage Table combinations -
  https://support.opentable.com/s/article/Managing-Table-Combinations-in-GuestCenter
- Enable Table Status Options / Understanding statuses in GuestCenter -
  https://support.opentable.com/s/article/Understanding-statuses-in-GuestCenter
- Seat guests and manage your shift with the mobile app -
  https://support.opentable.com/s/article/mobileapp
- Navigate the iPad app (server sections) -
  https://support.opentable.com/s/article/Navigating-GuestCenter-1505261219615
- Server Sections (YouTube) - https://www.youtube.com/watch?v=o9w-w4lk0IY
- Save time with OpenTable's built-in communication tools -
  https://support.opentable.com/s/article/Gather-reservation-confirmations
- Exchange direct messages with guests (2-way SMS) -
  https://support.opentable.com/s/article/Direct-Messaging-Restaurant-FAQ
- Restaurant SMS Messaging (Premium Communications) -
  https://www.opentable.com/restaurant-solutions/products/features/premium-sms-messaging/
- Guest relationship management features available on OpenTable Pro -
  https://support.opentable.com/s/article/profeatures
- The benefits of POS integration -
  https://support.opentable.com/s/article/GuestCenter-POS-Integration
- OpenTable & Toast POS Integration -
  https://www.opentable.com/restaurant-solutions/toast-opentable-better-together/
- Getting Started with Upserve POS / OpenTable (automatic check creation) -
  https://help.upserve.com/s/article/Getting-Started-with-your-Upserve-POS-OpenTable-Integration
- 3 Proven payment strategies to help reduce no-shows -
  https://www.opentable.com/restaurant-solutions/resources/3-proven-payment-strategies/
- Set up Booking Policies with options to require credit cards -
  https://support.opentable.com/s/article/Manage-your-own-Cancellations-and-No-Shows
- Improve no-show numbers by 40% -
  https://www.opentable.com/restaurant-solutions/resources/no-show-diners-numbers/
- OpenTable Product Innovations -
  https://www.opentable.com/restaurant-solutions/opentable-product-innovations/
- Reservations Report / Gather key insights with reports -
  https://support.opentable.com/s/article/Reservations-Report-in-GuestCenter

OpenTable (diner side and press)

- What can a restaurant or a restaurant's OpenTable profile help me with -
  https://help.opentable.com/s/article/What-can-a-restaurant-help-me-with
- What are cancellation, no-show and deposit policies (Diner Community) -
  https://help.opentable.com/s/article/What-are-cancellation-no-show-and-deposit-policies
- OpenTable Lets Diners Book Their Favorite Seat in the House (Seating
  Options, 2018) - https://press.opentable.com/news-releases/
- OpenTable now lets diners choose their seats (USA Today, 2018) -
  https://www.usatoday.com/story/travel/2018/08/16/opentable-now-lets-diners-choose-seats/
- OpenTable guide (ReservationFinder) -
  https://www.reservationfinder.io/guides/opentable-guide
- OpenTable block in WordPress -
  https://wordpress.com/support/wordpress-editor/blocks/opentable-block/
- Jetpack OpenTable Block -
  https://jetpack.com/support/jetpack-blocks/opentable-block/
- Integrate OpenTable Reservations with your Thryv Website -
  https://learn.thryv.com/hc/en-us/articles/360027708952

Pricing and fees (third party)

- OpenTable Pricing in 2026: Plans, Fees and Real Costs (Eat App) -
  https://restaurant.eatapp.co/blog/opentable-pricing
- OpenTable Pricing 2026: Real Costs With Cover Fees Explained -
  https://restaurantbookingsystem.com/compare/opentable-pricing/
- OpenTable Pricing Review (Tekpon) -
  https://tekpon.com/software/opentable/pricing/
- OpenTable Review 2026 (Perfect Venue) -
  https://www.perfectvenue.com/post/opentable-review
- OpenTable's 2% Service Fee on No-Shows and Deposits (beancount.io) -
  https://beancount.io/blog/2026/09/05/opentable-2-percent-service-fee-no-show-deposits/
- OpenTable begins adding a 2% service fee (Philadelphia Inquirer) -
  https://www.inquirer.com/food/restaurants/opentable-service-fee-no-show-restaurants
- r/restaurantowners: OpenTable takes $1 for every Google cover -
  https://www.reddit.com/r/restaurantowners/comments/1rvlbc2/
- How Much Does a Restaurant Reservation System Cost? (TableNest) -
  https://tablenest.app/blog/restaurant-reservation-system-cost-us
- OpenTable Competitors & Alternatives (Eat App) -
  https://restaurant.eatapp.co/blog/opentable-alternatives
- Resy Pricing 2026 - https://restaurantbookingsystem.com/compare/resy-pricing/
- SevenRooms Pricing 2026 -
  https://restaurantbookingsystem.com/compare/sevenrooms-pricing/
- SevenRooms Pricing 2026: What It Really Costs -
  https://restaurantsnapshotforghl.com/blog/sevenrooms-pricing-doordash-2026/
- Restaurant Reservation Cancellation Fees: The Complete Guide (Toast) -
  https://pos.toasttab.com/blog/on-the-line/restaurant-reservation-cancellation-fees
- How to Reduce No-Shows (Toast) -
  https://pos.toasttab.com/blog/on-the-line/how-to-reduce-no-shows
- Making a restaurant reservation? That'll be $100 (CBS News, 2024) -
  https://www.cbsnews.com/news/restaurant-reservation-fee-cancellation/
- r/restaurant: What do we think about reservation fees -
  https://www.reddit.com/r/restaurant/comments/1j61op6/
- Average dining time benchmarks -
  https://restaurantbookingsystem.com/academy/glossary/average-dining-time/
- Turn times by party size (openresto GitHub issue) -
  https://github.com/karanshukla/openresto/issues/452

Resy / ResyOS / Tock

- Reservations, Waitlists, Hospitality Tools | Join Resy -
  https://resy.com/join/reservations/
- ResyOS Restaurant Reservations and Table Management Software -
  https://os.resy.com/portal
- Choose The Right Plan For Your Business | Join Resy -
  https://resy.com/resyos/plans-and-pricing/
- ResyOS Help Center FAQ - https://helpdesk.resy.com/resyos-faq-B1ciD7Uu
- Fixed Seating Times (Resy helpdesk) -
  https://helpdesk.resy.com/en/articles/3939088-how-to-setup-fixed-seating-times
- Notify Feature (Resy helpdesk) -
  https://helpdesk.resy.com/en_us/what-is-notify-and-how-does-it-work-BJrJzPQLu
- Resy Waitlist vs Notify -
  https://guides.seatswiper.com/resy-waitlist-vs-notify
- Global Dining Access by Resy - https://resy.com/global-dining-access
- ResyOS review (restauranttools.ai) - https://restauranttools.ai/tools/resyos
- Plans & Pricing | Tock - https://www.exploretock.com/join/pricing/
- Deposits For Restaurant Reservation and Booking | Tock -
  https://www.exploretock.com/join/resources/deposit-for-restaurant-reservation
- Creating an Experience - Tock -
  https://tock.zendesk.com/hc/en-us/articles/360031145011-Creating-an-Experience
- What Is Tock and How Do Prepaid Reservations Work? -
  https://reservations.gg/blog/what-is-tock-prepaid-reservations
- What Is Tock? (ReservationFinder) -
  https://www.reservationfinder.io/guides/tock-guide

SevenRooms

- Restaurant Reservation System | SevenRooms -
  https://sevenrooms.com/platform/reservations-waitlist/
- Restaurant Table Management System | SevenRooms -
  https://sevenrooms.com/platform/table-management/
- Restaurant CRM & Segmentation | SevenRooms -
  https://sevenrooms.com/platform/crm/
- Hospitality CRM & Marketing Software -
  https://sevenrooms.com/power-guest-experience/
- SevenRooms (SwiftPOS integration help; status definitions) -
  https://help.swiftpos.com.au/sevenrooms
- SevenRooms User Guide (xnPOS) -
  https://xnpos.helpjuice.com/sevenrooms-user-guide
- SevenRooms Terms of Service - https://sevenrooms.com/terms-of-service/

Yelp, Toast, Google

- Yelp Guest Manager maximizes your restaurant's reach -
  https://business.yelp.com/restaurants/products/yelp-guest-manager/
- Yelp Host & Yelp Guest Manager Pricing -
  https://business.yelp.com/restaurants/yelp-restaurants-pricing/
- Never miss a call with Yelp Host -
  https://business.yelp.com/restaurants/products/yelp-host/
- Yelp Guest Manager product news -
  https://business.yelp.com/restaurants/products/guest-manager-product-news/
- Yelp Guest Manager review (restauranttools.ai) -
  https://restauranttools.ai/tools/yelp-guest-manager
- Toast Tables | Restaurant Reservation Software -
  https://pos.toasttab.com/products/toast-tables
- Introducing Toast Tables -
  https://pos.toasttab.com/news/introducing-toast-tables-reservation-waitlist-management
- Use Toast Tables -
  https://support.toasttab.com/en/article/Using-Toast-Tables-Waitlist
- Get Started With Toast Tables -
  https://support.toasttab.com/en/article/Getting-Started-Toast-Waitlist
- Toast Tables FAQ -
  https://support.toasttab.com/en/article/Troubleshooting-FAQ-Toast-Tables-Waitlist
- Overview and Eligibility | Google Actions Center (Reservations E2E) -
  https://developers.google.com/actions-center/verticals/reservations/e2e/overview
- Reservations End-to-End Integration Policies -
  https://developers.google.com/actions-center/verticals/reservations/e2e/policies
- Reservations End-to-End Partner Portal -
  https://developers.google.com/actions-center/verticals/reservations/e2e/partner-portal
- Implement the booking server -
  https://developers.google.com/actions-center/verticals/dining/guides/end-to-end/
- Proto interface (CheckAvailability, CreateBooking, UpdateBooking,
  GetBookingStatus, ListBookings, SetMarketingPreference) -
  https://developers.google.com/actions-center/verticals/reservations/e2e/reference/
- Reserve with Google: Restaurant Setup Guide (Reslify) -
  https://reslify.com/en/blog/how-reserve-with-google-works/
- Reserve with Google partners - https://www.google.com/maps/reserve/partners

## Guest-facing features (feature | description | tier | who offers it)

### Search and slot selection

| Feature                                       | Description                                                                                                                                                  | Tier | Who offers it                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------- |
| Availability search by date, time, party size | Three-field picker (party size, date, time); time defaults to the next sensible slot (for example 7:00 PM); party size usually 1-20 with "larger party" link | TS   | All                                                                           |
| Slots near the requested time                 | Show roughly 3-5 bookable times bracketing the requested time (for example +/- 1 to 2.5 hours) as tappable chips                                             | TS   | OT, RY, 7R, TK, YG, TT, RwG                                                   |
| "No availability" fallbacks                   | Show next available times on the same day, then alternative dates (next days with availability), and "notify me"                                             | Core | OT, RY, 7R, TK, YG                                                            |
| Day-level availability calendar               | Calendar greys out sold-out or closed days; Tock and Resy show per-day availability for the booking horizon                                                  | Core | TK, RY, 7R, OT (partial)                                                      |
| Seating-area choice                           | Each slot can carry a seating type: Standard, Bar, Counter, High-top, Outdoor/Patio; OT shipped "Seating Options" in 2018 [S]                                | Core | OT, RY ("Dining Room", "Bar", "Patio" as separate slot types), 7R, TK, YG, TT |
| Slot-level labels / offers                    | Slot tagged with an offer or experience (for example "Tasting menu", "Happy hour", "Bonus points", "Pop-up")                                                 | Adv  | OT (Experiences, POP), RY, TK, 7R                                             |
| Shared/communal and counter seating           | Bookable as its own inventory type                                                                                                                           | Adv  | RY, TK, 7R, OT                                                                |
| Time-limited table notice                     | "Table needed back at 9:00 PM" shown before confirming                                                                                                       | Core | OT, RY, 7R, TK                                                                |

### Booking details and identity

| Feature                          | Description                                                                                                                    | Tier | Who offers it                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------ |
| Guest booking without account    | Book with name, phone, email only (widget / RwG); account optional                                                             | TS   | OT (widget), 7R, YG, TT, RwG               |
| Account / logged-in booking      | Saved profile, history, upcoming reservations, favorites                                                                       | Core | OT, RY, TK, YG (Yelp account)              |
| Contact capture                  | First/last name, mobile phone (often SMS-verified), email; marketing opt-in checkbox per restaurant                            | TS   | All                                        |
| Phone verification               | SMS OTP on first booking to deter fake bookings                                                                                | Core | RY, OT (for some flows), 7R (configurable) |
| Special occasion                 | Pick list: Birthday, Anniversary, Date night, Business meal, Celebration                                                       | Core | OT, RY, 7R, TK, YG                         |
| Special requests / notes         | Free-text note to the restaurant (often 250-500 char limit)                                                                    | TS   | All                                        |
| Dietary restrictions / allergies | Structured tags (gluten-free, nut allergy, vegetarian, shellfish, etc.) plus note; OT diner profile stores dietary preferences | Core | OT, RY, 7R, TK                             |
| Custom questions                 | Restaurant-defined questions on the booking form (for example "Highchair needed?")                                             | Adv  | 7R, TK, OT (limited)                       |
| Saved diner preferences          | Dietary, seating preference, occasions saved on account and pre-filled                                                         | Adv  | OT, RY, TK                                 |

### Policies, payments and protection

| Feature                             | Description                                                                                            | Tier                   | Who offers it                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------- |
| Cancellation policy display         | Policy text shown before confirm and in confirmation; checkbox acknowledgment when a fee applies       | TS                     | All                                               |
| Credit-card guarantee (hold)        | Card stored (setup intent / auth) and charged only on no-show or late cancel                           | Core                   | OT [S], RY, 7R, TK, YG, TT                        |
| Deposits                            | Charge per person or per booking upfront; applied to the bill or refunded per policy                   | Core                   | OT [S], RY, 7R, TK, YG                            |
| Full prepayment / tickets           | Pay full price (prix-fixe, tasting menu, event) at booking; Tock's defining model [S]                  | Adv                    | TK, OT (prepaid Experiences) [S], RY (events), 7R |
| Policy by date, shift, party size   | Card required only for large parties, holidays, or Friday/Saturday                                     | Core                   | OT, RY, 7R, TK                                    |
| Platform service fee passthrough    | OT deducts 2% on no-show fees, deposits, prepaid Experiences; US restaurants may pass it to diners [S] | n/a (vendor economics) | OT                                                |
| Wallet payments                     | Apple Pay / Google Pay on deposit or prepay                                                            | Adv                    | TK, RY, 7R                                        |
| Gratuity / service charge on prepay | Add tip or service charge at prepay                                                                    | Adv                    | TK, 7R                                            |

### Confirmation and post-booking

| Feature                      | Description                                                                            | Tier              | Who offers it                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------ |
| Confirmation page            | Summary, policy, directions, manage link                                               | TS                | All                                              |
| Confirmation email           | Branded email with details, add-to-calendar, modify/cancel links                       | TS                | All                                              |
| Confirmation SMS             | Text with details and manage link [S for OT]                                           | TS                | OT [S], RY, 7R, YG, TT                           |
| Reminders                    | Automated reminder before visit (email and/or SMS)                                     | TS                | All                                              |
| Reconfirmation request       | SMS asking guest to reply "C"/"Y" or tap to confirm; status flips to Confirmed in book | Core              | OT, RY, 7R, YG, TT                               |
| Modify via link              | Change date/time/party size; re-checks availability and policy                         | TS                | All                                              |
| Cancel via link              | Self-cancel; late-cancel fee applied automatically if inside window                    | TS                | All                                              |
| Add to calendar              | ICS / Google / Outlook links                                                           | TS                | OT, RY, 7R, TK, YG, TT                           |
| Two-way messaging            | Guest replies to SMS land in host inbox (running late, questions) [S]                  | Core              | OT [S], 7R, YG, TT, RY                           |
| "Running late"               | One-tap "I'm running late" from SMS / app                                              | Adv               | OT, RY, 7R                                       |
| Pre-orders / add-ons         | Pre-order drinks, cake, wine, or menu items with the reservation                       | Adv               | TK, 7R, OT (add-ons on Experiences)              |
| Post-visit review / feedback | Review request after the visit; OT verified diner reviews                              | Core              | OT, YG (Yelp reviews), 7R (private feedback), RY |
| Loyalty points               | Diner points per booking (OT Dining Points)                                            | Adv (marketplace) | OT, RY (Amex perks)                              |

### Demand capture beyond a slot

| Feature                                   | Description                                                                                                                        | Tier | Who offers it                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------- |
| Notify me (future waitlist)               | Guest registers interest in a date/time window/party size; alerted when a matching slot opens; Resy calls it a future waitlist [S] | Core | RY [S], OT [S], 7R (priority alerts / waitlist), TK, YG |
| Remote waitlist join (same day)           | Join the walk-in waitlist online, see quoted wait, get "table ready" SMS                                                           | Core | YG, TT, RY, 7R, OT                                      |
| Waitlist position / live status page      | Link shows place in line and lets guest cancel                                                                                     | Core | YG, TT, 7R, RY                                          |
| Large-party request / request to book     | Above online max, guest submits a request; restaurant approves/declines                                                            | Core | OT, RY, 7R, TK, YG                                      |
| Private dining / event inquiry            | Request a space; OT "Request space" lets guests see availability and hold a space with a card [S]                                  | Adv  | OT [S], 7R, TK, RY                                      |
| Experiences / ticketed events / prix-fixe | Bookable product with its own price, inventory, dates, menu, policy                                                                | Adv  | TK [S], OT [S], RY, 7R                                  |
| Gift cards                                | Purchase gift cards via booking site                                                                                               | Adv  | 7R, TK, OT (via partners)                               |

### Channels

| Feature                             | Description                                                                                                                                                                         | Tier                                | Who offers it                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| Booking widget on restaurant site   | Embeddable button, inline widget, or link; WordPress/Jetpack OT blocks exist [S]                                                                                                    | TS                                  | All                                  |
| Direct booking link / hosted page   | Shareable URL for social bios and Google profile                                                                                                                                    | TS                                  | All                                  |
| Reserve with Google                 | Book from Google Search/Maps through a certified partner; partner implements a booking server (CheckAvailability, CreateBooking, UpdateBooking, GetBookingStatus, ListBookings) [S] | Core                                | OT, RY, 7R, TK, YG, TT (as partners) |
| Marketplace / discovery app         | Restaurant listed in a consumer network with search, reviews, photos                                                                                                                | Adv (network effect, not a feature) | OT, RY, TK, YG                       |
| Instagram / social "Reserve" button | Booking action on Instagram/Facebook                                                                                                                                                | Adv                                 | OT, RY, 7R                           |
| AI phone booking                    | AI answers calls and books/quotes waits; Yelp Host does this [S]                                                                                                                    | Adv                                 | YG (Yelp Host) [S], 7R, OT (newer)   |

## Operator-facing features (same table format, grouped by area)

### Setup: floor plan and inventory

| Feature                        | Description                                                                             | Tier | Who offers it          |
| ------------------------------ | --------------------------------------------------------------------------------------- | ---- | ---------------------- |
| Rooms / areas / seating areas  | Dining room, bar, patio, private room; each area can map to a guest-facing seating type | TS   | All                    |
| Tables with min/max covers     | Table name/number, min and max party size, shape                                        | TS   | All                    |
| Visual floor-plan editor       | Drag-and-drop tables, shapes, walls/labels                                              | Core | OT, RY, 7R, YG, TT     |
| Multiple floor plans           | Different layouts by shift or season (patio summer layout, brunch layout)               | Core | OT, RY, 7R             |
| Table combinations             | Predefined joined tables with their own min/max (for example T4+T5 = 6-8) [S for OT]    | Core | OT [S], RY, 7R, YG, TT |
| Online vs in-house only tables | Mark tables not bookable online (walk-in, VIP, bar)                                     | Core | OT, RY, 7R, YG, TT     |
| Table priority / ranking       | Order in which auto-assign fills tables                                                 | Adv  | OT, 7R, RY             |
| Bookable counter seats         | Seat-level inventory at bars/counters                                                   | Adv  | RY, TK, 7R             |

### Shifts, availability rules and pacing

| Feature                             | Description                                                                                               | Tier                             | Who offers it              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------- |
| Shifts / service periods            | Breakfast, lunch, dinner with day-of-week schedule, first and last seating                                | TS                               | All                        |
| Booking interval                    | Slot granularity, typically 15 minutes (also 30 / 60 options)                                             | TS                               | All                        |
| Sub-shifts / time periods           | Split a shift into peak/off-peak periods with different rules [S for OT]                                  | Core                             | OT [S], RY, 7R             |
| Accepted party sizes online         | Min/max per shift; OT range 1-20 [S]                                                                      | TS                               | All                        |
| Booking horizon (advance window)    | How far ahead guests can book (OT "Advanced booking settings") [S]                                        | TS                               | All                        |
| Release schedule                    | Open inventory on a rolling basis at a set time (for example 30 days ahead at 10 AM)                      | Adv                              | RY, TK, OT                 |
| Minimum lead time / same-day cutoff | Stop online bookings X minutes/hours before slot, or stop same-day at a time                              | TS                               | All                        |
| Pacing / flow control               | Max covers and/or max parties per interval; OT customizable every 15 minutes [S]                          | Core                             | OT [S], RY, 7R, TK, YG, TT |
| Turn times by party size            | Default dining duration per party size and per shift; OT range 15 min to 4 h [S]                          | Core                             | OT [S], RY, 7R, TK, YG, TT |
| Turn controls / fixed seatings      | Restrict to specific seating times per table for high-volume shifts (for example 5:30 and 8:00 turns) [S] | Adv                              | OT [S], RY [S], TK         |
| Access rules / held inventory       | Reserve inventory for a channel, guest tag, or experience (VIP, Amex, members) [S]                        | Adv                              | OT [S], RY, 7R, TK         |
| Online inventory share              | Limit what fraction of tables or covers is online vs held for walk-ins/phone                              | Core                             | OT, RY, 7R, YG             |
| Large-party definition              | Party size above which online booking becomes a request [S for OT]                                        | Core                             | OT [S], RY, 7R, TK         |
| Blocked tables / blocks             | Block a table or area for a time range (maintenance, VIP hold)                                            | Core                             | All                        |
| Special days / closures / overrides | Holiday hours, closed dates, special menus, separate pacing and policies                                  | TS (closures) / Core (overrides) | All                        |
| Availability insights               | Suggestions on turn times / pacing from history (OT "Display insights" in turn times) [S]                 | Adv                              | OT [S], 7R                 |
| Booking policies per shift          | Card required, deposit, cancellation window per shift/day/party size                                      | Core                             | OT, RY, 7R, TK             |

### Reservation book and service

| Feature                             | Description                                                                                                                           | Tier | Who offers it              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------- |
| Reservation list view               | List by shift with time, name, party size, table, status, tags, notes; filters (upcoming, seated, finished, cancelled, no-show)       | TS   | All                        |
| Timeline / grid view                | Tables on Y axis, time on X axis, reservation bars sized by turn time; drag to move                                                   | Core | OT, RY, 7R, YG, TT         |
| Floor-plan view with live states    | Tables colored by status, timers (time seated, time remaining), late indicators                                                       | Core | OT, RY, 7R, YG, TT         |
| Shift summary header                | Covers booked vs seated, parties, waitlist count, pacing per interval                                                                 | Core | OT, RY, 7R                 |
| Manual phone booking                | Host enters booking with phone lookup of existing guest                                                                               | TS   | All                        |
| Walk-ins                            | One-tap seat walk-in on a table                                                                                                       | TS   | All                        |
| Auto-assign tables                  | System assigns best-fit table at booking time and re-optimizes; 7R markets AI-driven seating [S]                                      | Core | OT, RY, 7R [S], YG, TT     |
| Manual table assignment / overrides | Host picks or changes table (OT mobile: "Change Assignment") [S]                                                                      | TS   | All                        |
| Overbook / force book               | Host books outside online rules (above pacing, odd time) with warning                                                                 | Core | OT, RY, 7R, YG             |
| Seating statuses                    | Arrived/partially arrived, partially seated, seated, course stages, check dropped, paid, bussing needed, finished (see lifecycle) [S] | Core | OT [S], 7R [S], RY, YG, TT |
| Late / no-show handling             | Late flag after grace period; mark no-show; auto-charge fee                                                                           | Core | All                        |
| Waitlist with quoted times          | Add party, quote wait (manual or predicted), track actual vs quoted                                                                   | Core | YG, TT, OT, RY, 7R         |
| "Table ready" SMS                   | Notify waitlisted party; guest can reply                                                                                              | Core | YG, TT, OT [S], RY, 7R     |
| Predicted wait times                | Wait estimates from turn data and current seating                                                                                     | Adv  | YG, TT, 7R, OT             |
| Server sections                     | Assign tables to servers per shift; editable from floor plan [S]                                                                      | Core | OT [S], RY, 7R, TT         |
| Server rotation / cover counts      | Track covers per server and suggest next section to seat                                                                              | Adv  | OT, 7R, RY                 |
| Shift notes / pre-shift             | Notes per shift/day for staff (86'd items, VIPs, events)                                                                              | Core | OT, RY, 7R                 |
| Guest-level alerts in book          | Icons for VIP, allergy, occasion, first visit, notes                                                                                  | Core | OT, RY, 7R, YG             |
| Multi-device sync                   | Host iPad, manager phone, web in real time                                                                                            | TS   | All                        |
| Offline mode                        | Continue working when network drops                                                                                                   | Adv  | OT, RY, 7R                 |
| Undo / audit trail                  | History of edits on a reservation (who changed what)                                                                                  | Core | OT, 7R, RY                 |

### Guest profiles / CRM

| Feature                  | Description                                                                     | Tier | Who offers it                      |
| ------------------------ | ------------------------------------------------------------------------------- | ---- | ---------------------------------- |
| Guest profile            | Contact, visit history, upcoming reservations, cancellations, no-shows          | TS   | All                                |
| Tags                     | VIP, Regular, Allergy, Industry, Press, Blacklist/do-not-book; custom tags      | Core | All                                |
| Automated tags           | Auto-tag top spenders, frequent visitors by rules; OT Pro feature [S]           | Adv  | OT Pro [S], 7R, RY                 |
| Guest notes              | Persistent notes (seating preference, wine preference)                          | TS   | All                                |
| Spend data               | Per-visit and lifetime spend from POS                                           | Adv  | OT (Core/Pro with POS), 7R, RY, TT |
| Duplicate merge          | Merge duplicate profiles                                                        | Core | OT, 7R, RY                         |
| Reviewer profile linkage | See profile of a reviewer from reviews (OT Pro "Guest Slideout in Reviews") [S] | Adv  | OT Pro [S], 7R                     |
| Segments / lists         | Filter guests by visits, spend, tags, last visit for marketing                  | Adv  | 7R, OT Pro, RY                     |
| Privacy/consent          | Opt-in status per channel, export/delete                                        | TS   | All                                |

### Communications and marketing

| Feature                                  | Description                                                                                        | Tier              | Who offers it                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| Templated confirmation/reminder messages | Edit text of confirmation, reminder, waitlist messages [S]                                         | Core              | OT [S], RY, 7R, YG, TT                |
| Two-way SMS inbox                        | Host replies to guests from the book [S]                                                           | Core              | OT [S], 7R, YG, TT, RY                |
| Email campaigns / automated marketing    | Broadcasts and automations (birthday, win-back) to diners; OT Pro includes automated marketing [S] | Adv               | OT Pro [S], 7R, RY (higher plans), TK |
| Post-visit surveys                       | Private feedback and NPS                                                                           | Adv               | 7R, OT, RY                            |
| Reviews management                       | Respond to reviews                                                                                 | Core              | OT, YG                                |
| Paid visibility / promotions             | Boost in marketplace (OT "Bonus points", promoted listings)                                        | Adv (marketplace) | OT, YG, RY                            |

### Payments

| Feature                           | Description                                                   | Tier | Who offers it          |
| --------------------------------- | ------------------------------------------------------------- | ---- | ---------------------- |
| Card guarantee and no-show charge | Store card, charge fee from the book on no-show / late cancel | Core | OT, RY, 7R, TK, YG, TT |
| Deposits and refunds              | Collect, apply to check, refund partial/full                  | Core | OT, RY, 7R, TK, YG     |
| Prepaid experiences               | Sell ticketed products, inventory per date                    | Adv  | TK, OT, RY, 7R         |
| Payment reporting                 | Fees collected, refunds, disputes                             | Core | OT, TK, 7R             |

### Integrations

| Feature                      | Description                                                                                                                                                                                                         | Tier                      | Who offers it                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------- |
| POS integration              | Table status from checks (opened = seated, items fired = courses, check closed = paid/finished), spend to profile; OT POS integration only on Core and Pro [S]; automatic check creation when table names match [S] | Adv (Core for TT, native) | OT [S], RY, 7R, TT (native), YG |
| Reserve with Google          | Partner integration                                                                                                                                                                                                 | Core                      | All partners                    |
| Website builders / social    | Widget, Instagram, Facebook                                                                                                                                                                                         | TS                        | All                             |
| Calendar / CRM / email tools | Mailchimp, Klaviyo, Salesforce                                                                                                                                                                                      | Adv                       | 7R, OT, RY                      |
| API / webhooks               | Partner API                                                                                                                                                                                                         | Adv                       | 7R, OT (partner), RY            |

### Reports and multi-location

| Feature                         | Description                                                          | Tier | Who offers it               |
| ------------------------------- | -------------------------------------------------------------------- | ---- | --------------------------- |
| Covers report                   | Covers and parties by shift/day/source                               | TS   | All                         |
| No-show and cancellation report | Rates by day, party size, source; fees collected                     | Core | OT, RY, 7R, YG              |
| Source / channel report         | Website widget vs marketplace vs Google vs phone vs walk-in          | Core | OT, RY, 7R, YG              |
| Turn time report                | Actual vs planned turn time by party size                            | Core | OT, RY, 7R, TT              |
| Waitlist report                 | Quoted vs actual wait, walk-aways                                    | Core | YG, TT, 7R                  |
| Server / section performance    | Covers and spend per server                                          | Adv  | 7R, OT, TT                  |
| Daily shift recap email         | Summary sent to managers                                             | Core | OT, RY, 7R                  |
| Multi-location / group views    | Switch venues, group-level CRM and reporting, central guest database | Adv  | 7R, OT, RY (Enterprise), TK |
| Roles and permissions           | Host vs manager vs admin; hide guest spend / contact                 | Core | All                         |

## Typical defaults and numbers

| Item                                     | Typical value                                                                                                                                                                                                                                               | Source / confidence                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Booking interval                         | 15 min standard; 30 min common for simple setups; OT flow controls configurable per 15 min [S]                                                                                                                                                              | High                                  |
| Turn time range                          | OT allows 15 min to 4 h per party size [S]                                                                                                                                                                                                                  | High                                  |
| Default turn times (casual/full-service) | 1-2: 75-90 min; 3-4: 90-105 min; 5-6: 105-120 min; 7-8: 120-150 min; 9+: 150-180 min                                                                                                                                                                        | Medium (industry norms)               |
| Fine dining / tasting menu turns         | 2-3 h, often fixed seatings                                                                                                                                                                                                                                 | Medium                                |
| Online party size                        | OT accepted party sizes 1-20 [S]; most restaurants cap online at 6-8 and route larger to request/phone                                                                                                                                                      | High (range) / Medium (cap)           |
| Booking horizon                          | Commonly 30-60 days; OT restaurants often release 14-30 days ahead [S]; hot spots release 7-30 days ahead at a fixed time (often midnight or 9-10 AM) [S]; some 90+ days                                                                                    | Medium                                |
| Minimum lead time / same-day cutoff      | 0-60 min before slot for online bookings is typical; some stop same-day online at shift start                                                                                                                                                               | Medium                                |
| Pacing                                   | Set per 15 min interval as covers (for example 12-30 covers) or parties (for example 3-6 parties)                                                                                                                                                           | Medium                                |
| Slot hold during booking flow            | Platforms temporarily lock the slot while the guest completes details/payment; 5-10 min is typical in the market (some show a countdown). Google E2E integrations use a lease/hold step in the API family                                                   | Low-Medium (not confirmed by snippet) |
| Cancellation window                      | 24 h most common; 48-72 h for fine dining, large parties, holidays; some 2-4 h for casual                                                                                                                                                                   | Medium-High                           |
| No-show / late-cancel fee                | $10-$50 per person common; $25-$50 pp at fine dining reported [S CBS, Reddit]; $100+ pp for tasting menus via deposits/prepay                                                                                                                               | Medium-High                           |
| Deposit patterns                         | Fixed per person (for example $20-$50 pp), percentage of prepaid menu, or full prepayment (Tock) [S]; deposit applied to the bill                                                                                                                           | Medium-High                           |
| Platform fee on payments                 | OT deducts 2% on no-show fees, deposits, prepaid Experiences [S]                                                                                                                                                                                            | High                                  |
| Reminder timing                          | Reminder 24 h before (email/SMS); same-day reminder 2-4 h before is common; reconfirmation request 24-48 h before                                                                                                                                           | Medium                                |
| Late grace period                        | 15 min common before table may be released; host shown "late" after 5-15 min                                                                                                                                                                                | Medium                                |
| Waitlist "table ready" response window   | 5-10 min to return/reply before the party may be skipped                                                                                                                                                                                                    | Medium                                |
| Notes length                             | 250-500 characters                                                                                                                                                                                                                                          | Low                                   |
| OT pricing (reported)                    | Basic about $149/mo, Core about $399-499/mo, Pro about $699/mo; network covers about $1.00-1.50 per cover; website/widget covers free on Core/Pro [S: "all reservations from your website are free" on Core & Pro]; Google covers reported at $1 [S Reddit] | Medium (check vendor)                 |
| Resy pricing (reported)                  | From $249/mo [S]; historic tiers Platform / Platform 360 / Full Stack / Enterprise, no per-cover fees [S]                                                                                                                                                   | Medium                                |
| Yelp Guest Manager                       | From about $99/mo [S]                                                                                                                                                                                                                                       | Medium                                |
| SevenRooms                               | No public list price; quote-based [S]                                                                                                                                                                                                                       | High                                  |

## Reservation lifecycle and statuses

Booking-state (pre-arrival):

| Status                     | Meaning                                                                | Visible to guest?                                         |
| -------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Requested / pending        | Large-party or request-to-book awaiting approval; also pending payment | Yes ("Request received")                                  |
| Booked / not confirmed     | Reservation exists; no reconfirmation yet                              | Yes ("Confirmed" from guest's view: booking is confirmed) |
| Confirmed / reconfirmed    | Guest replied to reconfirmation SMS or clicked confirm                 | Indirectly (guest sees "Thanks for confirming")           |
| Left message / unreachable | Host attempted to call (OT "Left message", "No answer")                | No                                                        |
| Wrong number               | Contact failure flag                                                   | No                                                        |
| Running late               | Guest sent late message                                                | Guest initiates                                           |
| Late                       | Past reservation time, not arrived (system flag after grace)           | No                                                        |
| Waitlist (same day)        | Walk-in queue; "Notified", "Table ready" sub-states                    | Yes (position / table ready)                              |

Arrival and seating (staff-only):

| Status                             | Meaning                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Partially arrived                  | Some guests at host stand, none seated                                                   |
| Arrived / all arrived (checked in) | Party waiting to be seated                                                               |
| Partially seated                   | Assigned a table but not all guests arrived [S, SevenRooms definition]                   |
| Seated                             | All guests at table; seating timer starts                                                |
| Course stages                      | Appetizer / Entree (Main) / Dessert / Cleared [S: OT mobile shows Entree, Cleared, Paid] |
| Check dropped                      | Bill presented                                                                           |
| Paid                               | Check closed (often from POS) [S]                                                        |
| Bussing needed                     | Guests left, table needs reset [S: OT quick-select "Bussing Needed"]                     |
| Finished / done / left             | Reservation complete, table free [S: "Finish"]                                           |

Terminal / exceptions:

| Status                               | Visible to guest?                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| No-show                              | Partly (fee notification/charge receipt; OT diners may have account consequences) |
| Cancelled by guest                   | Yes                                                                               |
| Late cancel (by guest inside window) | Yes, with fee                                                                     |
| Cancelled by restaurant              | Yes (notification with reason/apology)                                            |
| Declined (request not accepted)      | Yes                                                                               |
| Expired hold (abandoned checkout)    | Not a stored reservation; guest sees "time expired"                               |

Notes:

- Restaurants can enable/disable which table statuses appear (OT "Enable Table
  Status Options") [S]; status sets are configurable in OT and 7R.
- With POS integration, seated/course/paid statuses can be driven by check
  events [S for OT POS and Upserve automatic check creation].
- Guest-visible states usually collapse to: upcoming (confirmed), pending
  request, waitlisted, cancelled, completed, no-show.

## Host stand UX patterns

- Main screen during service is a split view: left column reservation/waitlist
  list for the current shift; right pane floor plan (or timeline toggle). Hosts
  switch between Floor, Timeline/Grid and List.
- Shift selector at top (date + Lunch/Dinner), with cover/party counts and a
  pacing strip showing booked covers per 15 min interval.
- List tabs/filters: Upcoming, Seated, Finished/Done, Waitlist, Cancelled /
  No-show. Sort by time.
- Each row: time, guest name, party size, table, status chip, icons for VIP,
  allergy, occasion, notes, first visit, card on file/deposit paid, source.
- Tables colored by state (available, reserved soon, seated, course stage, check
  dropped, paid, bussing) with a timer ring/badge showing minutes seated or
  minutes until next reservation; overdue tables highlighted.
- Primary actions are one tap: Seat, Mark arrived, Notify (table ready), Text,
  Change table, No-show, Cancel. Drag a reservation onto a table to seat or
  reassign [S: OT "Change Assignment"].
- Quick "+" for walk-in and "+" for phone reservation; phone number lookup
  auto-fills the guest profile.
- Waitlist panel: quoted wait, elapsed time, notify button, auto-suggested
  table.
- Guest profile slide-out: visits, spend, tags, notes, past no-shows.
- Server sections overlay toggled from floor plan [S]; covers per server.
- Shift notes visible at top or as a banner; inbox badge for 2-way SMS.
- iPad-first, landscape, large touch targets; works on phone (manager view) [S:
  OT mobile app]; real-time sync across devices.

## Booking widget UX patterns

- Compact three-control bar (party size, date, time) + "Find a table" button;
  inline widget or button opening a modal/new page [S: WordPress/Jetpack
  OpenTable blocks].
- Results as time chips around the requested time; each chip may show seating
  type (Standard, Bar, Patio) or experience label; unavailable chips hidden or
  greyed.
- If nothing near the time: show other times that day, then next available
  dates, then "Notify me" and "Join waitlist" (same day).
- Party sizes above the online max show "For larger parties, call us" or a
  request form.
- Selecting a slot starts a short hold, then shows a details step: name, phone,
  email, occasion, request note, dietary tags, marketing opt-in, policy text.
- Card/deposit step appears only when the slot's policy requires it; policy and
  fee amount stated next to the card field.
- Confirmation page with add-to-calendar, directions, modify/cancel link.
- Mobile-first, single column, few fields; returning guests pre-filled.
- Branding (colors, logo) customizable; widget language follows locale.

## Plan/tier packaging observed (e.g., what OpenTable Basic vs Core vs Pro includes)

OpenTable (restaurant side) [S for plan pages and the snippets noted]:

- **Basic**: listing on the OpenTable diner network and marketing tools to fill
  seats when needed [S]; reservation book with limited table management; free
  30-day trial [S]; per-cover fees on network and website bookings (reported).
  Historically positioned like "Connect" for restaurants that "don't need table
  management" [S for Connect].
- **Core**: everything in Basic plus "more table management features" [S] (floor
  plan, table states, waitlist, availability planning, server sections),
  website/widget reservations free of cover fees [S], POS integration [S], 2%
  fee on prepaid ticketing [S].
- **Pro**: all Basic and Core features plus relationship management and
  automated marketing [S]: automated tags, guest slideout in reviews [S],
  segmented email campaigns, guest spend insights, advanced reporting.
- Add-ons: Private Dining / Event Management (Request space) [S], Premium
  Communications (SMS) [S], Experiences, payment features (2% service fee) [S].
- Contracts typically annual, auto-renewing [S Perfect Venue].

Resy / ResyOS: four plans [S], historically Platform, Platform 360, Full Stack,
Enterprise; no per-cover fees [S]; starts about $249/mo [S]. Higher plans add
POS integration, CRM depth, marketing, events/ticketing, multi-venue. Tock now
shares pricing pages with Resy [S].

Tock: tiers built around prepaid experiences, deposits and takeout; transaction
fees on prepaid sales (exact tiers not confirmed in this research).

SevenRooms: quote-based [S]; positioned as reservations + table management +
CRM + marketing automation + direct online ordering; strong multi-venue.

Yelp Guest Manager: from about $99/mo [S]; waitlist, reservations, table
management; add-on Yelp Host AI phone answering [S].

Toast Tables: add-on to Toast POS; waitlist + reservations, native POS table
status [S product pages].

Reserve with Google: not a product tier; restaurants choose a certified partner,
partners must meet eligibility and policy requirements [S].

## Notes and uncertainties

- FetchUrl was prohibited, and many OpenTable/Resy help pages are rendered by
  Salesforce/JavaScript, so only snippets were visible. Exact per-plan feature
  matrices and current prices should be verified directly with vendor pages
  before quoting to stakeholders.
- OpenTable Core monthly price is reported differently ($399 vs $499) across
  third-party sources; per-cover fees vary by plan and source (network, website,
  Google at about $1 [S Reddit]).
- The slot-hold duration during checkout (5-10 min) is a market convention, not
  confirmed for any specific vendor in the search snippets.
- Default turn times by party size are industry norms; vendors ship editable
  defaults and do not publish one canonical table.
- Status names differ by vendor (OT "Finished", 7R "Left/Completed", Resy
  "Done"); the lifecycle above is a superset.
- Ownership context (affects roadmap): SevenRooms is a DoorDash company [S];
  Resy and Tock are both under American Express and share pricing [S].
- Reserve with Google requires a certified partner and a booking server
  implementing Google's Reservations End-to-End API (availability feed +
  CheckAvailability/CreateBooking/UpdateBooking/GetBookingStatus/ListBookings)
  [S]; eligibility and policy requirements apply [S]. For Menuza this is a
  multi-month partner-certification track, not a quick toggle.
- Data residency note for Menuza (not from research): guest PII captured during
  booking (name, phone, email, dietary notes) fits the regional tenant-db model,
  and guest booking widgets should call tenant-api directly like existing Sites
  customer auth.
