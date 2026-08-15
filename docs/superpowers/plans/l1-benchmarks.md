# L1 durability benchmark record

## Acceptance status

**Performance acceptance is deferred and has not passed.** The 2026-08-07
scope split permits the Task 6 writer-coordinator correctness foundation to be
completed without replacing the current sql.js full-database publication
architecture. It does not change either original target:

- project save end-to-end p95 `< 300 ms`
- full database publish p95 `< 500 ms`

The benchmark remains an explicit opt-in acceptance gate. Normal correctness
suites discover the tests but skip their expensive bodies. To run the unchanged
gate in PowerShell:

```powershell
$env:MYTHPEN_RUN_DURABILITY_BENCHMARK = '1'
bun test ./server/tests/durability-benchmark.test.js
$benchmarkExitCode = $LASTEXITCODE
Remove-Item Env:MYTHPEN_RUN_DURABILITY_BENCHMARK
exit $benchmarkExitCode
```

Until the deferred storage redesign is implemented, the expected result on the
measured reference host is **two assertion failures**, not a pass. Do not remove
the environment gate, reduce the fixture, or relax the thresholds to make this
test green.

## Reproducible method

- Runtime: Bun 1.3.14 (`0d9b296a`)
- Host: Windows 10.0.19045, Intel Core i7-8700 @ 3.20 GHz, 16 GiB RAM
- Fixture: 3,000 chapters, each containing 3,400 Chinese characters
- Warm-up: 2 unreported operations
- Measurement: 20 operations, nearest-rank p50/p95, plus max
- Full publish database: 29.32 MiB, minimal chapter table, direct
  `AtomicStore.publish()` timing
- End-to-end database: 35.52 MiB, production project schema and current
  `ManuscriptService.writeChapterBody()` path, including writer lease, recovery,
  SQL guard/update, durable terminal publication, and release
- Test source: `server/tests/durability-benchmark.test.js`

The 2026-08-07 historical measurement below used the then-current direct
`projectExecute()` benchmark call. After the ManuscriptService boundary became
mandatory, the 2026-08-11 acceptance rerun retained the same fixture, warm-up,
sample-count, percentile and threshold protocol but moved the measured save to
the current production manuscript entry point.

## Measured result — 2026-08-07

| Scenario | Target | Measured p95 | Result |
|---|---:|---:|---|
| Full AtomicStore publish | `< 500 ms` | **1642.90 ms** | FAIL |
| Project save end-to-end | `< 300 ms` | **1533.30 ms** | FAIL |

Full publish samples, milliseconds:

```text
1035.53, 1022.83, 1052.09, 1357.73, 1576.50,
2850.79, 1642.90, 1080.61, 1144.06, 1362.72,
1347.61, 1304.23, 1496.27, 1487.39, 1529.19,
1560.54, 1602.69, 1469.08, 1124.00, 1207.28
```

Project save samples, milliseconds:

```text
1074.96, 1339.45, 1338.29, 1397.40, 1304.62,
1265.56, 1385.17, 1337.99, 2153.92, 1533.30,
1108.52, 1368.36, 1427.69, 1528.13, 1203.05,
1194.33, 1169.68, 1472.56, 1351.50, 1387.09
```

## Measured result — 2026-08-11 final implementation rerun

- Source commit: `fa12d8a5b7565dac18f54e8af40e9dc7cf8b89cc`
- Runtime/host: Bun 1.3.14, Windows 10.0.19045, Intel Core i7-8700,
  16 GiB RAM
- Method: unchanged 3,000 × 3,400-character fixture, 2 warm-up + 20
  measured operations, nearest-rank p50/p95 and max; the end-to-end call path
  was updated as documented above
- End-to-end timing path: production `ManuscriptService.writeChapterBody`,
  including the writer lease, SQL guard, durable publication and release
- Command exit: 1, with exactly two performance-threshold assertion failures;
  both benchmark JSON records were emitted successfully

| Scenario | Target | p50 | p95 | max | Result |
|---|---:|---:|---:|---:|---|
| Full AtomicStore publish | `< 500 ms` | 928.35 ms | **1122.41 ms** | 1126.39 ms | FAIL |
| Project save end-to-end | `< 300 ms` | 1264.05 ms | **1664.70 ms** | 1892.42 ms | FAIL |

Full publish samples, milliseconds:

```text
939.88, 833.27, 818.94, 760.44, 727.48,
737.69, 808.09, 909.13, 928.35, 976.97,
1070.57, 1116.79, 1122.41, 1115.87, 1126.39,
864.51, 857.67, 973.17, 1047.11, 1078.36
```

Project save samples, milliseconds:

```text
1180.98, 1110.11, 1071.09, 1150.24, 1088.02,
1340.42, 1090.49, 1139.49, 1261.30, 1451.60,
1464.38, 1525.37, 1664.70, 1892.42, 1159.40,
1502.66, 1607.36, 1304.20, 1264.05, 1454.68
```

This rerun closes the stale benchmark-harness gap that had attempted a direct
chapter body UPDATE after the ManuscriptService boundary was introduced. The
fixture seed still uses the test-only raw setup scope, while every measured
save uses the production manuscript path. No fixture, sample count or threshold
was relaxed. Performance acceptance therefore remains deferred and not passed.

## Diagnostic conclusion and deferred work

One end-to-end project save performs exactly one recovery and one publication;
the failure is not caused by duplicate publication. Phase profiling attributes
the dominant cost to full candidate and before-backup durable writes, repeated
30 MiB disk reads and SHA-256 checks, and formal-path SQLite verification. A
same-volume hard-link backup and reuse of an already-computed hash improve
constants but still leave the theoretical median above the 500 ms publish
target, so they cannot close either acceptance gap.

A temporary Bun native SQLite probe measured single-row durable commits in the
same 29.32 MiB fixture at 3.20 ms p95 for WAL + `synchronous=FULL`, 9.79 ms p95
when followed by a full checkpoint, and 9.64 ms p95 for DELETE journal +
`synchronous=FULL`. Those numbers justify a separate architecture redesign;
they do not authorize a Task 6 production migration. The redesign must preserve
the existing journal, crash-recovery, identity, and fail-closed guarantees and
receive its own plan and review before implementation.

## Next performance milestone

当前性能工作不再以继续微调 sql.js 全库发布作为完成路径。下一里程碑必须先
形成并审阅 NativeProjectStore/native transaction/bounded checkpoint 的独立
设计和 TDD 计划，同时保留现有 crash recovery、identity、writer lease、
ControlStore 与 fail-closed 不变量。实现后仍使用相同的 3,000 × 3,400 fixture、
2 次 warm-up、20 次 measurement、nearest-rank p50/p95/max 和原始 300/500 ms
阈值重跑；只有两项均真实通过，Task 6 性能验收才能改为 PASS。

Therefore:

- Task 6 writer-coordinator correctness foundation: eligible for completion.
- Task 6 performance acceptance: deferred, not passed.
- Full L1 durability completion: not claimed.
