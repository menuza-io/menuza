# Owner insights PR checklist

- [x] #369: Two dishes in 20 orders → pair count 20 (test)
- [x] #369: Modifier attach rate matches order data (test)
- [x] #369: Voided lines do not count (test)
- [x] #368: Dish sold out twice → two occurrences with durations (loader +
      schema)
- [x] #368: Lost-sales estimate only with enough history
      (SOLD_OUT_LOST_SALES_MIN_ORDERS)
- [x] #368: Location scope + cost permission (sales ctx + field gate)
- [x] #391: Totals equal the sum of orders in period (common test)
- [x] #391: Tax per rate (common test)
- [ ] #391: CSV matches screen (page stub; export TBD)
- [x] #370: Locations ranked correctly per metric (common test)
- [ ] #370: Scoped manager sees only their locations (page loader TBD)
- [ ] #377: Setting goal shows progress on Home (Goals page only; Home block
      TBD)
- [x] #377: Projection matches run rate (test)
- [x] #377: No goal → prompt to set (Goals page)
- [x] #387: Every tile shows update time (tile-freshness test)
- [x] #387: Refreshing updates it (tile-freshness test)
