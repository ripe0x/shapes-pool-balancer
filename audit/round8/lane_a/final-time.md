# Round 8 Lane A cumulative auditor time

**Best estimate of active auditor time through the per-ID Slither triage: about 88 minutes (1 h 28 min), with roughly ±5 minutes uncertainty.** The conservative first-artifact-to-last-triage wall span is **108 min 16 s**, including the controller-mandated hold of approximately 20 min 39 s between blind seal and informed release. Both measures are below the original **3 auditor-hour** lane ceiling. This record adds no test, source change, or change to prior seals.

| Phase | UTC window on 2026-11-12 | Approximate active time | Basis |
| --- | --- | ---: | --- |
| Execution preflight | By **15:37:11–15:38:13** | 2–3 min | Earliest timestamped lane file is `preflight/build.log` creation at 15:37:11; `preflight/record.md` last modified 15:38:13. Preparation may have begun a minute or two earlier. |
| Blind discovery | **15:39:07–15:58:21** | 19 min 14 s | Corrected timestamp in immutable `discovery-seal.md`, also explained in `informed/post-seal-ghost-continuation.md`. |
| Controller hold | **15:58:21–about 16:19** | **Excluded** | Lane instructed to stop and await the other seal; approximately 20 min 39 s of elapsed time. |
| Informed review, public-seizure continuation and map | **about 16:19–16:39** | ~20 min | Corrected `informed/post-seal-ghost-continuation.md`; supersedes mistaken 39-minute discovery attribution in immutable `informed/review.md`. |
| Security follow-up | **about 16:39–16:47** | ~8 min | `informed/security_followup/record.md`. |
| Real-fork fuzz | **about 16:47–16:50** | ~3 min | `informed/fuzz/record.md`. |
| ABI/callsite coverage and receiver grief | **about 16:50–17:03** | ~13 min | `coverage-review.md` file history (created 16:55:54, last modified 17:02:13) and receiver log 16:59:09–16:59:24. Start/end include reading and writing outside those file timestamps. |
| Curated hostile-collection validation | **about 17:04–17:12** | ~8 min | `validation/record.md`, first test log 17:04:44 and final log 17:10:28–17:10:36; record created 17:11:48. |
| Actual-router public-seizure continuation | **about 17:12–17:14** | ~2 min | `validation/ghost_router/record.md`, final log 17:13:27–17:13:33, record created 17:14:04. |
| Surface entrypoints and ENS | **about 17:14–17:20** | ~6 min | `validation/surface_edges/record.md`, first log 17:18:02 and final log 17:19:14–17:19:20, record created 17:19:58. |
| 40-ID Slither triage | **about 17:21–17:25:27** | ~4–5 min | `slither-id-triage.md`, created 17:23:53 and last modified **17:25:27**; phase record states approximately 17:21–17:25. |

**Timestamp method.** File birth/modification times were read with `stat -f '%N|birth=%SB|modified=%Sm' -t '%Y-%m-%dT%H:%M:%S%z'` and converted from local `-0500` to UTC. The first observable lane artifact at **15:37:11 UTC** and the last Slither triage modification at **17:25:27 UTC** are 6,496 seconds apart. Subtracting the approximate 1,239-second controller hold gives **5,257 seconds, or 87 min 37 s**, of active-window elapsed time. The phase estimates round to about 88 minutes. They include preparation, reading, writing and tool execution; they do not attempt to isolate keyboard time. The uncertainty covers the approximate informed-release time, preflight preparation before the first timestamp, and small gaps between artifact writes. The recorded endpoint excludes this final accounting note itself. No new test was run for this calculation.
