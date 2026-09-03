# Market-price audit of pre-gate live products (2026-09-03)

LAUNCH-BACKLOG 14b, approved 2026-09-02, run 2026-09-03 from the local checkout (read-only:
Shopify Admin product reads + 23 SerpApi google_shopping lookups, all n=40 offers, upper-median
per the pipeline's own quantile). "Ceiling" = 1.3 × median, the gate every NEW listing now passes.
Queries were each title's lead segment — treat ×1.3–1.5 rows as judgment calls (feature premiums
may justify them) and ×2+ rows as real mispricing. Report only; no prices were changed.

## Flagged OVER the 1.3× ceiling (14)

| Product | Ours | Median (n=40) | Ceiling | ×median |
|---|---|---|---|---|
| Ice Silk Cooling Pet Bed Mat | $29.99–$39.99 | $13.99 | $18.19 | ×2.86 |
| 3-in-1 Pet Steam Grooming Brush | $49.99 | $18.00 | $23.40 | ×2.78 |
| Gravity Push Pet Nail Scissors | $29.99 | $10.99 | $14.29 | ×2.73 |
| Durable Rubber Squeaky Rugby Ball | $25.99 | $10.00 | $13.00 | ×2.60 |
| Smart Auto-Rolling Cat Toy Ball | $21.99 | $9.99 | $12.99 | ×2.20 |
| Luxury Small Dog Bed w/ Hidden Storage | $279.99 | $139.69 | $181.60 | ×2.00 |
| Luxury Small Dog Sofa Bed w/ Storage Trunk | $239.99 | $122.21 | $158.87 | ×1.96 |
| Human-Size Dog Bed | $199.99–$209.99 | $109.95 | $142.94 | ×1.91 |
| Automatic Dog Ball Launcher | $149.99 | $84.99 | $110.49 | ×1.76 |
| LED Light-Up Waste Bag Dispenser | $17.99 | $10.99 | $14.29 | ×1.64 |
| Portable Dog Water Dispenser Bottle | $29.99 | $19.94 | $25.92 | ×1.50 |
| Low Noise Pet Hair Clipper | $54.99 | $36.99 | $48.09 | ×1.49 |
| Portable Dog Pooper Scooper | $32.99 | $23.99 | $31.19 | ×1.38 |
| Nylon Anti-Grind Adjustable Collar | $26.99 | $19.95 | $25.94 | ×1.35 |
| Semi-Enclosed Plush Pet Bed House | $34.99 | $25.99 | $33.79 | ×1.35 |

## Under-priced (1)

| Rechargeable Dog Training Collar | $59.99 | $89.00 | $115.70 | ×0.67 — room to raise |

## In range (7)

GPS Fence & Tracker ×1.06 · Traffic Leash ×1.08 · Corduroy Sofa Bed ×1.18 · Car Dog Bed ×1.20 ·
Carrier Backpack ×1.20 · Mesh Step-In Harness ×0.89 · No-Pull Tactical Harness ×0.90.
(Foldable Water Bottle skipped — listed 2026-09-03 through the live market gate.)

## Next step (pending Robert)

A suggested-reprice list (ceiling-clamped, 60%-floor-checked against CJ costs) on request;
execution manual in Shopify admin or scripted from an approved list. Prices are merchandising
calls — nothing changes without explicit approval.
