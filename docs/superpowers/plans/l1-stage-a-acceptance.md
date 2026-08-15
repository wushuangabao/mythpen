# L1 Stage A Acceptance Record

日期：2026-08-11
compiled Desktop 验收基线提交：`da9ebb1c1d68cc17cbd57e8f25b50de5ff60c633`
RecoveryNotice E2E 提交：`beceb76a0594bea368298e4ade02e83c2b1d90d4`
分支：`codex/l1-durability-foundation`

## Verdict

| 范围 | 状态 | 结论 |
|---|---|---|
| Stage A Task 1–9 | **COMPLETE** | 代码、聚焦测试、修复与逐任务独立复审均已完成 |
| Task 10 | **COMPLETE** | 自动化、sidecar、服务端现场、五个 Desktop 生命周期场景与 RecoveryNotice E2E 已验收；slow-drain 合同已按生产调用链正式收敛 |
| Stage A local acceptance | **COMPLETE** | 本机代码、编译产物、现场与 UI 验收均已闭环；发布状态单独记录 |
| Task 8 publication track | **NOT AUTHORIZED / NOT RUN** | installer、tag、release 与发布产物验收均未执行；不属于当前执行范围 |
| Full L1 | **NOT COMPLETE** | NativeProjectStore、schema 11、D4、性能与 Stage B–D 均未完成 |

本文区分“代码实现完成”“本机证据通过”“最终验收完成”和“已发布”。环境或平台
`NOT_RUN` 不会被单元测试、源码审查或构建成功替代。`slow_drain_cancel` 不再记为
`NOT_RUN`：生产树没有可跨事件循环存活的异步 admitted writer，因此它不是当前产物
可出现的运行场景；这一不变量由自动扫描门禁保护，若未来出现异步 admission，门禁直接失败。

## Blocking classification and next actions

| 类别 | 当前事实 | 下一动作 |
|---|---|---|
| Stage A 验收证据 | 五个 Desktop 生命周期场景与同一通道的 RecoveryNotice E2E 已通过；slow-drain 已按生产调用链判定为结构上不可达，并有扫描门禁 | 已闭环；保持回归门禁 |
| 已确认性能失败 | 两个 3,000 章基准均超过原始 p95 阈值 | 保留现有 gate；进入单独评审的 NativeProjectStore/native transaction/checkpoint 重构，不再靠缩小 fixture 或放宽阈值收口 |
| 后续架构范围 | schema 11、canonical trigger digest、旧版本 DML 负控、activation 与 Stage B–D 未实施 | Stage A 本地验收已闭环，立即按 `2026-08-11-l1-durability-stage-b-native-project-store.md` 推进 Stage B；无需等待发布 |
| 发布与平台 | installer、tag、release、Linux、macOS 未运行 | 保持独立待授权交付轨；只有完整 L1 候选成熟并获明确授权后才执行 |

当前实现优先级：NativeProjectStore 与 schema 11 → native transaction/bounded
checkpoint → fixture activation 与旧版本 DML 负控 → 性能及跨平台矩阵。Windows
installer、tag、release 保持 `NOT_RUN`，不作为 Stage B/C 前置；任何真实环境
`NOT_RUN` 都保留原状态，不折算为 PASS。

## Evidence identity

| 项目 | 值 |
|---|---|
| OS | Windows 10.0.19045 / NTFS |
| Bun | 1.3.14 (`0d9b296a`) |
| Node | v24.11.1 |
| pnpm | 10.10.0 |
| Rust host | `x86_64-pc-windows-msvc` |
| lifecycle harness SHA-256 | `D4D6293D026D16343C2417A65C9F9C2B7743F9CB15634FEBDF6250DC3E8BBB81` |
| build contract test SHA-256 | `139589176A817DE72833F41B64C38BB1951CA705A6846FF2847212959AF62F72` |
| production admission scanner SHA-256 | `2A89D0AA034056AAC57DBFA2CDC8FB080F61F4393E4034B5ECC85533C622D3F3` |
| RecoveryNotice scene seeder SHA-256 | `A1795032CBA89C0E847CC98E6F460728394E8B3C71BDFEB49C455123BC20EE5B` |
| compiled sidecar SHA-256 | `F6064ECA2D0622E2938710538234EA5726846377DE48DFB9B7CD4BB7E5A4F8D6` |
| debug Desktop SHA-256 | `46A539F8AE1DDA905576F04CECFD29AD4B2B0C1C02F7AC3DFBF46C8EF1A5B6F4` |

`ready` 与 authenticated `build.info` 已核验 compiled mode=`off`、完整 source
commit=`da9ebb1c1d68cc17cbd57e8f25b50de5ff60c633`、实际 target triple 与真实
child PID/nonce digest。runtime 环境变量不能改变编译模式。

## Automated gates

全量历史 gate 来自验收基线提交；本轮工作树对 build contract、fault-injection、
debug Desktop 与 diff/status 做了新鲜重跑。opt-in 性能失败单列，不伪装成普通
correctness gate 失败。

| 命令 | 结果 |
|---|---:|
| `pnpm test:server` | PASS：460 pass / 3 expected skip / 0 fail |
| `pnpm test:client` | PASS：191 / 191 |
| `pnpm test:contracts` | PASS：13 / 13 |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS：0 error；80 warning / 1 info；未产生修改 |
| `pnpm build` | PASS；仅既有 chunk/dynamic-import warning |
| `node scripts/assert-production-write-admission.mjs` | PASS：`asyncAdmissions=[]`，9 个生产 admission 均为同步入口 |
| `node --test scripts/tests/build-sidecars.test.mjs` | PASS：10 / 10，包含 admission 扫描与真实 PowerShell SelfTest |
| `bun test ./server/tests/shutdown-coordinator.test.js ./server/tests/project-write-coordinator.test.js` | PASS：48 / 48 |
| `bun test ./server/tests/fault-injection.test.js` | PASS：14 / 14 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS：27 / 27 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | PASS |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS |
| `pnpm build:sidecar` | PASS |
| `pnpm tauri build --debug --no-bundle` | PASS |
| `git diff --check` | PASS |

首次把长套件并行执行时，服务端首个 5 秒测试因资源竞争超时并触发 Bun
`node:test` 级联错误；停止精确遗留测试进程后按仓库约定串行重跑，得到上表
460/3/0 的权威结果。该次并行失败不计为产品回归。

## Compiled sidecar

命令：

```powershell
powershell.exe -NoProfile -File .\scripts\tests\desktop-lifecycle-smoke.ps1 -Mode Desktop -TimeoutSeconds 60
```

| 场景 | 状态 | 证据 |
|---|---:|---|
| fake 3001 | PASS | 两个实例均使用非 3001 的动态 loopback 端口 |
| ready/build.info | PASS | PID、nonce digest、off/full commit/triple 全绑定 |
| runtime mode bypass | PASS | production 值不能改变 compiled `off` |
| wrong nonce | PASS | health/JSON/SSE/blob/control 全拒绝，正确 nonce 仍可用 |
| cross-instance nonce | PASS | A nonce 对 B 的五类入口均拒绝 |
| normal shutdown | PASS | 严格 `quiescing → draining → closing → complete`，自然 exit 0 |
| cancel shutdown | PASS | attempt 1 取消、旧 continuation 拒绝、admission 恢复、attempt 2 clean |
| closing cancel | PASS | 精确返回 `CONTROL_CANCEL_TOO_LATE` |
| continue wait | PASS | closing soft deadline 重武装后 clean complete |
| default user roots | PASS | data/control/WebView2/path-store/registry 前后相同 |
| slow drain cancel | **NOT APPLICABLE / STRUCTURALLY PROVEN** | 生产扫描得到 `asyncAdmissions=[]`；9 个真实 admission 均为同步入口，无法跨事件循环与 shutdown command 并存。若以后引入异步入口，构建合同立即失败；协调器 48/48 覆盖异步 drain/cancel/stale continuation 状态机 |

## Debug Desktop

debug Desktop 已从当前验收基线重新编译。harness 不再使用
`Process.MainWindowHandle`：它按 Desktop PID 枚举顶层窗口，只接受可见、响应且
class=`Tauri Window`、title=`Mythpen` 的真实应用窗口，因此 `-siw` single-instance
辅助窗口和 `Tao Thread Event Target` 均不能提前满足 readiness 或接收 minimize/
hide/focus/WM_CLOSE。

当前 WebView2 151 对 `remote-debugging-port=0` 不建立 listener；harness 改为先
独占保留一个显式正整数 loopback 端口，Desktop 启动前释放，连接前再验证监听
PID 的祖先链必须回到本次 Desktop，且链上 WebView2 命令行必须绑定本次受控
user-data root 与同一端口。Desktop 使用正常 GUI `Start-Process` 启动；sidecar
控制管道保持原实现。CDP helper 只返回表达式结果，不再把异步 `VoidTaskResult`
混入 session。

实跑结果：

| 场景 | 状态 | 关键证据 |
|---|---:|---|
| second instance show/unminimize/focus | PASS | 真实应用窗口被隐藏/最小化后，第二实例使其显示、还原并聚焦；第二隔离根字节不变，未生成第二 sidecar |
| desktop session binding | PASS | 真实渲染页取得 authenticated 动态 port/nonce、owned child PID 与 off/full commit/triple |
| desktop normal owned-child shutdown | PASS | WM_CLOSE 后 owned child 先以 code 0 退出，Desktop 随后 code 0 退出 |
| emergency two-step UI | PASS | session 发布后 marker 才武装隔离 close fault；真实对话框完成两步确认，owned child 非 clean 退出且先于 Desktop |
| unowned sentinel survival | PASS | 独立 authenticated sentinel 在 emergency 后仍返回 health 200，随后 clean shutdown |
| RecoveryNotice rendered interaction | PASS | 同一真实渲染/nonce 通道完成键盘进入、`aria-live`、迟到刷新取消、真实 423 busy、刷新、opaque export 与双重 ready 恢复 |
| default user roots | PASS | data/control/WebView2/path-store/registry 前后相同 |

实跑 exit code 为 0，七项均 PASS；运行后须继续用精确 retained process handle
和默认根快照作为回归门禁。Desktop CDP 已不再阻止 Task 10；发布与完整 L1
剩余范围见下文。

## Task 8 field matrix

最终实现提交上执行：

```powershell
bun .superpowers/sdd/task-10-task8-field-evidence.js
bun test --timeout 15000 ./server/tests/project-route-collision.test.js
```

ignored 服务端现场 harness 为 7 PASS / 0 FAIL / 1 NOT_RUN；其中唯一 NOT_RUN 是
它保留的旧 `RecoveryNotice-real-browser-interaction` 占位，已由上节同一真实 Desktop
harness 的 PASS 证据替代，不折算也不重复计数。reserved-name 集成为 2 pass / 0 fail。

| 场景 | 状态 | 关键断言 |
|---|---:|---|
| v1 forward | PASS | HTTP GET/POST 后 ready，terminal=`sqlite.publish.committed` |
| v1 rollback | PASS | HTTP GET/POST 后 ready，terminal=`sqlite.publish.rolled_back` |
| third state | PASS | 409 `RECOVERY_REQUIRED`，130 项证据树完全不变 |
| schema too new | PASS | migration/recovery/open/DML 前拒绝，130 项与 DB SHA-256 不变 |
| healthy + bad startup | PASS | healthy ready，坏项目独立 isolated |
| diagnostics export | PASS | UUID opaque 文件名、真实 DB hash、严格白名单、无路径/正文 |
| external writer busy | PASS | 独立进程持 lease，HTTP 423，证据树不变 |
| reserved names | PASS | 七个保留名不进入 `router.param('project')` |
| RecoveryNotice rendered interaction | PASS | v1 prepared fixture 由同一 Desktop harness 驱动；真实键盘/focus、取消、busy/error、刷新、导出、恢复、`aria-live` 与 nonce transport 均通过 |

## Performance evidence

最终实现提交上的 opt-in benchmark 使用 3,000 章 × 3,400 中文字符、2 次
warm-up、20 次 measurement 与 nearest-rank。方法与输出完整，两个原始阈值
均未达到：

| 场景 | 目标 | p50 | p95 | max | 结果 |
|---|---:|---:|---:|---:|---:|
| Full AtomicStore publish | `< 500 ms` | 928.35 ms | 1122.41 ms | 1126.39 ms | FAIL / DEFERRED |
| Project save end-to-end | `< 300 ms` | 1264.05 ms | 1664.70 ms | 1892.42 ms | FAIL / DEFERRED |

端到端计时路径走正式 `ManuscriptService.writeChapterBody`，未绕过 SQL guard；
fixture、样本数和阈值均未放宽。完整样本见 `l1-benchmarks.md`。

## Deferred and platform ledger

| 项目 | 状态 |
|---|---:|
| NativeProjectStore / native transaction / bounded checkpoint | DEFERRED |
| schema 11 canonical trigger generator | DEFERRED |
| trigger set digest 的 code/project_meta/sqlite_schema 三方比对 | DEFERRED |
| v0.0.7–v0.0.9 generator-driven DML negative control | DEFERRED |
| fixture_only / production activation 与 Stage B–D | DEFERRED |
| Windows installer install/start/exit/uninstall | NOT_RUN |
| Linux build/smoke | NOT_RUN |
| macOS build/capability/smoke | NOT_RUN |
| tag/release artifacts/release smoke | NOT_RUN |

## Conclusion

Stage A Task 1–10 的本地代码与验收工作已经完成。自动化 gate、compiled sidecar、
Task 8 服务端字节级现场、五个 Desktop 生命周期场景与 RecoveryNotice 真实 UI
均通过；slow-drain 合同已用生产调用链清单、自动扫描门禁和协调器状态机测试正式
收敛为当前产物不适用，而非未运行。Task 8 的实现验收因此完成；对外发布未授权且
不阻塞后续实现。NativeProjectStore、schema 11、性能与 Stage B–D 尚未完成，
所以完整 L1 仍未完成。
