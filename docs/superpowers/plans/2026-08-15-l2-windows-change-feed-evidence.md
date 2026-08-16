# L2 Windows `ReadDirectoryChangesW` 直接变化 feed 实测证据

日期：2026-08-16

结论：在本文限定的 L2 v1 Windows 支持包络内，`manuscriptChangeNotification = true`。该结论只适用于 Bun `1.3.14+0d9b296af` Windows x64 编译产物、本地 NTFS 固定磁盘、三个非递归目录句柄、每目录独立 OVERLAPPED 状态与 1 MiB 正常缓冲区、freshness gate 先零超时同步排空已完成 event 的直接 `ReadDirectoryChangesW` 实现；它不适用于 Bun `fs.watch`，也不扩张 L1 已排除的网络盘、云同步根和 reparse point。

## 1. 判定标准

本轮不要求每个底层动作逐一交付。通过条件是：`pumpAll()` 必须完成一轮没有取得任何 completion 的三 feed 探测并返回该轮建立的 `linearizationSnapshot`，其中三个 stream 全部 armed、三个手动复位 event 在同一可线性化时点均为 nonsignaled；在该同步点之前的每个相关路径要么已经被 dirty 证据覆盖，要么 `coverageLost` 已由零字节完成、`ERROR_NOTIFY_ENUM_DIR` 或更强失败显式锁存。若线性化快照不成立，或者仍有未覆盖路径却报告持续覆盖成立，则判为 false-clean 并整轮失败。

Microsoft 文档说明，`ReadDirectoryChangesW` 的首个调用会为目录句柄建立固定大小的内部缓冲区，调用间变化继续进入该缓冲区；缓冲区溢出时可能以调用成功但返回字节数为 0 的方式报告整批细节已丢失，调用方应重新枚举目录。本文把零字节完成和 `ERROR_NOTIFY_ENUM_DIR` 都映射为同一个单调 `coverageLost` 锁存。[ReadDirectoryChangesW 官方文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)

探针没有注册原生线程到 JavaScript 的回调，而是让每个 OVERLAPPED 使用唯一的手动复位 event，并由 freshness 同步点以 `WaitForSingleObject(..., 0)` 和 `GetOverlappedResult` 排空完成；最终无进展轮的第一次 nonsignaled 采样作为线性化时点，因为该轮没有 `ResetEvent`，后续同样返回 nonsignaled 的手动复位 event 在该时点不可能已经是 signaled。这避开了 Bun FFI 原生 callback 的线程与生命周期风险，也不再依赖一个未检查 event 的裸布尔谓词。[Bun FFI 官方文档](https://bun.sh/docs/runtime/ffi)

## 2. 环境与可复现资产

- 操作系统：Windows 11 Home China，Windows build `10.0.26200`，x64。
- 文件系统：`C:\`，本地 fixed drive，NTFS。
- Bun revision：`1.3.14+0d9b296af`。
- Bun 二进制 SHA-256：`0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c`。
- 探针源码：[scripts/l2-windows-change-feed-probe.mjs](../../../scripts/l2-windows-change-feed-probe.mjs)，SHA-256 `444106f11146b28726dca7e22b1d734e813fce51c2c62210bc69b6ade5f826f0`。
- 编译探针 SHA-256：`aab8fed77a8ee33425b77a9d65bc4a4d02f9ab602fd36b50e92d94e5c60ac5e7`。
- 原始结果：[2026-08-15-l2-windows-change-feed-result.json](./2026-08-15-l2-windows-change-feed-result.json)，SHA-256 `f909e6baab6b821699c3343ffb4bc1b8a5c2261b39ab4677d52a2d5ec569d67d`。
- 有效运行窗口：`2026-08-16T03:34:37.114Z` 至 `2026-08-16T03:35:02.822Z`；probe version 3；8/8 用例通过，8/8 都建立并断言完整线性化快照，进程退出码 0。

编译与运行命令：

```powershell
& 'C:\GitHub\mythpen\src-tauri\target\bun-runtime\bun.exe' build 'scripts\l2-windows-change-feed-probe.mjs' --compile --target=bun-windows-x64 --outfile '.codex-tmp\l2-windows-change-feed-probe.exe'
& '.codex-tmp\l2-windows-change-feed-probe.exe' --output 'docs\superpowers\plans\2026-08-15-l2-windows-change-feed-result.json'
```

## 3. 结果矩阵

| 用例 | 刺激 | 原生结果 | 判定 |
|---|---|---|---|
| 三目录可达 | 分别写 `mythpen/`、`volumes/`、`chapters/` 的规范路径 | 3/3 路径进入 dirty，无 coverage loss | PASS |
| 低速不同路径 | 独立进程写 1,000 个章节路径，每个文件配置等待 2 ms | 1,000/1,000 路径进入 dirty，无 coverage loss | PASS |
| 高速不同路径 | 独立进程无等待写 5,000 个章节路径 | 5,000/5,000 路径进入 dirty；`chapters` feed 解析 10,000 条 add/modify 记录，无 coverage loss | PASS |
| 决定性强制溢出 | 每目录缓冲区缩到 512 字节，独立进程写 20,000 个章节路径，写完前故意不排空 | 具体路径只覆盖 1/20,000，但 `mythpen` 与 `chapters` 两个 feed 均返回零字节完成；第一次 freshness 同步建立完整线性化快照并得到 `canReportContinuousCoverage=false`，`coverageLost` 持续锁存 | PASS |
| 同路径重复写 | 同一路径连续写 2,000 次 | 该路径进入 dirty，无 coverage loss；具体记录数允许合并或重复 | PASS |
| 完成到重新布防边界 | 取得第一批完成后故意暂缓重新布防，在间隙写第二个路径，再恢复布防 | 2/2 路径均交付；未布防期间 `canReportContinuousCoverage=false`，无静默缺口 | PASS |
| 候选写入与原子替换 | 候选写入、文件 fsync、rename/replace，重复 20 次 | 目标路径出现 20 次 `renamed_new_name`，后 19 次替换另有 `removed`；目标闭包持续为 dirty | PASS |
| 目录身份锁 | 在三个 feed 保持打开时分别尝试改名 `chapters/`、`volumes/`、`mythpen/` | 三次都以 `EBUSY` 被阻止，目录身份不能在覆盖句柄下静默换壳 | PASS |

## 4. 决定性结论

强制溢出用例把「事件很多但没有发生溢出」这个解释排除了：512 字节内部缓冲区只留下 1 个具体章节路径，19,999 个路径细节不可恢复，但两个相关目录句柄都产生了零字节成功完成。探针在解析任何可用路径之前先锁存 `coverageLost`，第一次 freshness 同步返回非 clean，后续重新布防不清除锁存；只有规格定义的成功完全校验才有权恢复可信基线。

完成到重新布防用例又把另一个空窗单独拉出来：第一批完成已取走且第二次调用尚未发出时写入第二个路径，重新布防后该路径仍由句柄关联的内部缓冲区交付。生产实现仍按更保守的顺序立即重新布防再解析旧缓冲，测试中的人为停顿只用于证明 Windows 句柄在调用间保留变化。

probe version 3 删除了未检查 event 的 `#rawCanReportClean()`，改由 `#synchronizationProvesContinuousCoverage(pumpResult)` 只消费 `pumpAll()` 返回的线性化快照；普通 `snapshot()` 只保留带时间语义的 `lastPumpResult`，不能被误当成新的 freshness gate。八个用例的 pass 条件现在都要求 `linearizationSnapshotEstablished=true`，所以 event 探测、armed 状态和 coverage-loss 状态不再通过分散字段拼成结论。

因此，Bun `fs.watch` 的既有静默丢失结论仍然成立，但不会传染给直接 feed：两条 API 路径的关键差异不是底层是否可能丢细节，而是 L2 是否能消费原生零字节/错误完成，并在 freshness gate 的明确线性化点报告持续覆盖之前把丢失升级为全脏。

## 5. 保留边界

- 本轮证明的是平台原语与 Bun 编译产物组合可实现规格契约，不代表生产适配器、恢复流程或 UI 已经实现；集成后的第 15.4 节验收仍必须重跑同一矩阵。
- 正常 1 MiB 压力用例完整覆盖 5,000 个路径，但规格不依赖这个容量永不溢出；任何规模的零字节完成或错误完成都走全脏与完全校验。
- 本轮实际观测到的是零字节成功完成，没有观测到 `ERROR_NOTIFY_ENUM_DIR`；两者在契约中同级，后者仍必须保留测试注入与错误映射。
- 后台事件泵只降低延迟。正确性依赖每次 freshness gate 在检查 clean 前同步排空当时可取的三个 event；原生完成尚未可取时仍存在第 9.1 节明确承认的投递延迟。
- USN Change Journal 不进入 L2 v1。进程未运行期间的变化仍由启动时先布防直接 feed、再做完全校验来覆盖。
