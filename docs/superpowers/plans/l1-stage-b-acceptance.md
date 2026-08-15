# L1 Stage B Acceptance Record

日期：2026-08-12  
分支：`codex/l1-durability-foundation`  
Task 7 correctness 实现提交：`bef7445592f37a8342de861d4cc9bb7df147bfd0`  
Stage A 历史账本：`l1-stage-a-acceptance.md`

## Verdict

| 范围 | 状态 | 结论 |
|---|---|---|
| Stage B Task 1–6 | **COMPLETE** | schema 11 direct fixture、native transaction/recovery、bounded ControlStore/checkpoint 已完成并独立复审 |
| Task 7 runtime correctness | **COMPLETE** | checkpoint reauth、absolute suffix、retry reset、Bloom 128、stale job 零写与 shutdown 已通过 |
| Stage B correctness acceptance | **COMPLETE** | 最终总审 APPROVE；Critical 0、可复现数据损坏风险 0 |
| Task 7 internal native diagnostics | **DEFERRED** | 未创建 internal projector/test；Stage A public diagnostics 不等同于此项 |
| Native Stage B benchmark | **NOT_RUN** | 未创建或执行 native benchmark，不声明性能通过 |
| Frozen binary-token gate | **DEFERRED / FORMAL GATE NOT MET** | mode-off graph 不含 testing authority，但通用 ControlStore validator 仍携带 fixture event-type 字面量；安全审查判定 authority leak 0，本轮不为形式 token 拆分核心模块 |
| Stage C / Stage D | **DEFERRED** | activation、旧版本 DML 负控、production candidate 与跨平台矩阵未完成 |
| Production wiring | **OFF / DEFERRED** | `db.js` 仍为 schema 10，native factory/open/write 未接生产 |
| Publication track | **NOT AUTHORIZED / NOT_RUN** | installer、push、tag、release 均未执行 |
| Full L1 | **NOT COMPLETE** | 性能、Stage C/D、生产接入、形式构建门禁及平台矩阵仍未满足 |

本文只确认 Stage B direct-fixture correctness 已收敛。它不等价于完整 L1、生产
activation、性能达标或已发布。用户要求的收敛模式冻结已经批准的 authority；只有
Critical 或可复现的数据损坏风险可以重新打开 Task 7 相邻实现。

## Evidence identity

| 项目 | 值 |
|---|---|
| OS / filesystem | Windows 10.0.19045 / NTFS |
| Bun | 1.3.14 |
| Node | v24.11.1 |
| pnpm | 10.10.0 |
| Rust host | `x86_64-pc-windows-msvc` |
| schema / writable tables / canonical triggers | 11 / 18 / 54 |
| trigger digest | `5b7051891e370d2dbfe5c924cf6d1b3cb7dcc896cab5bafa51f67be6a5a46afe` |
| checkpoint soft / hard | 4,096 events or 16 MiB / 8,192 events or 32 MiB |
| compiled server SHA-256 | `1D199AAB95D7194BAACFF9AE57920D0D5CCF3F5B2D705028747FAAEEBF19027D` |
| compiled CLI SHA-256 | `42944AACDA1737CA5CB9A9C7F452D61710D45EF46F4570F296E9B417E9687648` |

所有 Stage B fixture 均位于 helper-owned `%TEMP%\mythpen-native-stage-b-*`。本轮
没有读取、迁移或接入用户默认 data/control/path-store root。

## Runtime correctness gates

| Gate | Fresh evidence |
|---|---|
| checkpoint reauth / absolute suffix / retry reset / Bloom 128 | B2 focused 8/8；aged-history full 19/19 |
| stale job zero-write / same-facade frontier advancement | B3 focused 2/2；唯一终审 APPROVE |
| native regression | 84/84 |
| Task 6 checkpoint/control regression | 302/302 |
| coordinator + shutdown | 76/76 |
| shutdown convergence | fresh 13/13；唯一终审 APPROVE |
| syntax / diff | 6 个 `node --check` PASS；`git diff --check` PASS |

上述计数存在重叠，不相加成一个总测试数。沙箱内涉及 child process 的命令曾因
`uv_spawn EPERM` 失败；按既定规则在沙箱外复跑同一命令后得到上表结果，没有用
环境失败替代产品断言。

## RED / GREEN / review ledger

- B2：一次 focused RED；GREEN 8/8；唯一终审 APPROVE。
- B3：一次合法 soft-pressure RED 0/2；GREEN 2/2；唯一终审 APPROVE。
- B4：复用已有 shutdown RED/GREEN，不制造新 RED；fresh GREEN 13/13；唯一终审 APPROVE。
- Task 7 总审：APPROVE，Critical 0、可复现数据损坏风险 0。

## Private `activeEpochObservations` evidence

- Runtime 只证明 checkpoint null/present interval、membership/count 与 Bloom 后果。
- 一次静态代码审查确认：按 absolute event 顺序遍历；每个完整验证的 typed event
  exactly-once lowercase push；membership Set 与数组分离；数组冻结且不逃逸；provider
  转交同一个 private array。
- 没有新增，也不存在直接观察 private array order 的测试 seam。

## Mode-off compiled sidecar

| 证据 | 结果 |
|---|---|
| `pnpm build:sidecar` | PASS；真实 server/CLI 编译，server authenticated smoke 完成 |
| `node --test scripts/tests/build-sidecars.test.mjs` | PASS：10/10（沙箱外复跑；沙箱内仅 `spawn EPERM`） |
| build metadata | `nativeActivationMode=off`，full source commit 与 target triple 由 authenticated ready/build.info 绑定 |
| fresh dependency graph | 569 modules；不含 `server/testing/native-stage-b-store.js`、`server/testing/native-stage-b-fixture.js`、`server/testing/bounded-control-store.js` 或 `server/native/native-project-store.js` |
| testing factory / verifier authority | `createStageBFixtureStore`、fixture descriptor/hash verifier、closure-private admission verifier/provider 均不在 graph |

冻结计划还要求 fixture event type 的字节完全不进入 binary。真实 sidecar 仍包含
`sqlite.native.stage_b.fixture_genesis`，来源是 `server/control-store.js` 内休眠的 bounded
checkpoint 持久化 schema fail-closed validator；同一 graph 没有 bounded facade caller、
provider 或 testing verifier。两次独立安全审查均为 Critical 0、authority leak 0。

严格移除此字面量需要把 Task 6/7 的 bounded checkpoint parser/controller 从核心
ControlStore 拆分到 activation-specific module。该重构超出当前收敛范围，且会重新打开
已通过的 302 项 Task 6 crash/recovery 门禁；因此本账本将该形式门禁诚实保留为
`DEFERRED / FORMAL GATE NOT MET`，不把它伪装成 PASS，也不通过字符串拼接规避扫描。

## Repository gates not rerun

以下门禁本轮没有重跑，不写成当前提交 PASS；历史结果见 Stage A acceptance 账本：

| Gate | 状态 |
|---|---|
| `pnpm test:server` / `pnpm test:client` / `pnpm test:contracts` | NOT_RERUN |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | NOT_RERUN |
| Cargo test / fmt / clippy | NOT_RERUN |
| Tauri debug/no-bundle 与 Desktop UI matrix | NOT_RERUN |

## Performance, diagnostics and deferred scope

- Stage B native benchmark：`NOT_RUN`。
- Internal native diagnostics projector/tests：`DEFERRED`。
- 0/10,000/100,000 大历史性能矩阵与八段计时：`DEFERRED`。
- 既有 sql.js full publish p95=1122.41 ms、端到端保存 p95=1664.70 ms，继续为
  `FAIL / DEFERRED`；`<500 ms` native transaction 与 `<300 ms` E2E 尚未证明。
- Stage C/D、fixture/production activation、same-path adoption、旧版本 DML negative
  controls、POSIX missing-formal、Linux、macOS、Windows installer、push、tag、release 均为
  `DEFERRED` 或 `NOT_RUN`。

## Conclusion

Stage B direct-fixture correctness 已完成并固定在 `bef7445`。完整 L1 尚未完成；下一条
正确路径是 Stage C activation/旧版本 DML 负控，然后是形式构建门禁、性能与平台矩阵，
最后才是 Stage D production candidate。发布轨仍需用户独立授权。
