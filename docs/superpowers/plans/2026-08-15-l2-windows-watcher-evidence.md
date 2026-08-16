# L2 Windows watcher 实测证据

日期：2026-08-15

结论：Bun 1.3.14 Windows x64 编译产物的 `fs.watch` 支持本机递归通知，也能在低速写入下投递全部不同路径，但在高速不同路径写入下会无错误、无空文件名、无其他溢出信号地静默丢失事件。因此，仅凭 Bun `fs.watch` 不能把 Windows 的 `manuscriptChangeNotification` 判为 `true`。

后续状态：第 2.5 版已选择不经过 `fs.watch` 的 `ReadDirectoryChangesW` 直接变化 feed，并通过独立的八项原生矩阵；本文件保留为否定 `fs.watch` 权威资格的历史证据，当前能力判定见 [L2 Windows 直接变化 feed 实测证据](./2026-08-15-l2-windows-change-feed-evidence.md)。

## 1. 范围

本轮只验证 Windows，不把其他平台纳入 L2 第 2.4 版定稿证据。

四个必测问题全部覆盖：递归是否生效；压力或缓冲区耗尽时的可观察表现；事件是否会合并或丢失；「写候选 + 原子替换」的实际事件序列。

压力测试能证明 `fs.watch` 消费者可观察到静默丢失，但该 API 没有提供足够信息区分丢失发生在操作系统通知缓冲区、libuv/Bun 适配层还是 JavaScript 投递队列，因此证据不把内部层级归因写成事实。

## 2. 环境与证据身份

| 项目 | 值 |
|---|---|
| 操作系统内核 | Microsoft Windows NT 10.0.26200.0，x64 |
| 文件系统 | 本机 `C:` 卷，NTFS |
| Bun | `1.3.14+0d9b296af`，Windows x64 |
| Bun 编译器 SHA-256 | `0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c` |
| 探针源码 | `scripts/l2-watch-probe.mjs`，probe version 3 |
| 探针源码 SHA-256 | `c56660d25be94128258c97eb40fbac512b912ed5cae91997e0100aa5239cea0d` |
| 编译探针 SHA-256 | `6b8bdf380bcfc56b2b15b0ef670ce82a6b56cbca2c4db9e0e1e7a0cf0cd5ddd8` |
| 原始结果 | `docs/superpowers/plans/2026-08-15-l2-windows-watcher-result.json`，149,123 bytes |
| 原始结果 SHA-256 | `eb3f7b1c842573b5d36abd178fb9c4b6ff56167f97846f1a99e4a97c6b3c8d25` |

编译探针是约 94 MiB 的临时可执行文件，不进入仓库；仓库保留源码、编译器身份、编译产物哈希和原始 JSON，足以审查测试逻辑并重跑。

## 3. 方法

探针本身由 Bun 编译为独立 Windows x64 可执行文件。递归组在 `mythpen/` 根使用一个 `{ recursive: true }` watcher；平铺组分别对 `mythpen/`、`volumes/` 和 `chapters/` 使用三个非递归 watcher。

高速和低速不同路径测试由另一个独立编译进程创建文件，watcher 所在父进程的事件循环保持可运行。这排除了「生产者同步写文件时顺便阻塞了 watcher 回调」对主要静默丢失结论的干扰。

阻塞压力组由 watcher 进程同步创建大量文件，专门验证消费者暂时无法排空通知时的可观察表现。它不是主要能力判据，而是对缓冲区或队列耗尽场景的补充。

执行参数为 `--external-count 5000 --paced-count 1000 --paced-delay-ms 2 --overflow-count 20000 --same-file-writes 2000 --atomic-iterations 20`。

## 4. 结果

| 场景 | 观察结果 | 显式错误、空文件名或溢出信号 | 判定 |
|---|---:|---:|---|
| 递归：根目录直属文件 | 已观察到 | 0 | 递归 watcher 可用 |
| 递归：`chapters/deep-a/deep-b/` 两级嵌套文件 | 已观察到 | 0 | Windows 本机递归确实生效 |
| 同一文件连续写入 2,000 次 | 1 个匹配事件 | 0 | 事件会合并，不能按次数记账 |
| 独立进程高速写 5,000 个不同路径，递归 watcher | 观察 1,707，缺失 3,293 | 0 | 静默丢失 |
| 独立进程高速写 5,000 个不同路径，三个平铺 watcher | 观察 468，缺失 4,532 | 0 | 静默丢失 |
| 独立进程每个文件配置至少等待 2 ms 后写 1,000 个不同路径，递归 watcher | 观察 1,000，缺失 0；写入总时长 13.74 s | 0 | 低速对照通过 |
| 独立进程每个文件配置至少等待 2 ms 后写 1,000 个不同路径，三个平铺 watcher | 观察 1,000，缺失 0；写入总时长 13.84 s | 0 | 低速对照通过 |
| 同进程阻塞事件循环写 20,000 个不同路径，递归 watcher | 观察 1，缺失 19,999 | 0 | 压力下静默丢失 |
| 同进程阻塞事件循环写 20,000 个不同路径，三个平铺 watcher | 观察 1，缺失 19,999 | 0 | 压力下静默丢失 |
| 候选写入、`fsync`、原子重命名覆盖目标，重复 20 次 | 目标与候选每次都被观察到 | 0 | 本机观察序列稳定，但不能提升为 API 保证 |

20 次原子替换的归一化序列全部为 `rename:<candidate> -> change:<candidate> -> rename:<target>`。这只是一台 Windows/NTFS 机器上的观察值；实现仍必须按路径和发布后的 raw hash 对消自我事件，不得依赖事件数量、类型组合或顺序。

## 5. 对 L2 规格的影响

原第 9.1 节假定 watcher 会在缓冲区溢出或事件丢失时报告信号，再据此置全脏标记。高速独立进程组已经证明事件可以在 watcher 事件循环保持运行时静默丢失，所以该触发规则不能覆盖真实风险。

只要 Windows 实现仍以 Bun `fs.watch` 作为唯一变化来源，`manuscriptChangeNotification` 就必须固定为 `false`。`fs.watch` 事件可以作为刷新提示使用，但不能证明脏路径集合完整，也不能单独证明集合为空。

Windows 默认路径若因此让全脏标记常置，每次普通读写都会触发完全校验，第 16.1 节的「正常读取只做一次内存判断」和现有性能目标便没有成立前提。因此，本轮完成了文档要求的实测前置，却以负面结果暴露出一个仍需设计决策的阻塞项；第 9 节不能据此宣称已定稿。

第 2.4 版在此只能二选一：引入能够检测通知丢失并可触发可靠重同步的 Windows 变化检测原语，再按同一矩阵复测并争取把能力置为 `true`；或者明确接受 `manuscriptChangeNotification = false` 的常置全脏降级模式，同时重写第 15.4、16.1 和完成定义并取得产品与性能批准。第 2.5 版已经选择并验证第一条路径，本段不再代表当前阻塞状态。

## 6. 重跑

```powershell
src-tauri\target\bun-runtime\bun.exe build scripts\l2-watch-probe.mjs --compile --outfile .codex-tmp\l2-watch-probe-windows-x64.exe
.codex-tmp\l2-watch-probe-windows-x64.exe --external-count 5000 --paced-count 1000 --paced-delay-ms 2 --overflow-count 20000 --same-file-writes 2000 --atomic-iterations 20 --output .codex-tmp\windows-result.json
```

重跑必须使用本机 NTFS 路径，不得把探针根或被测文件树放在网络盘、WSL 映射、容器卷或虚拟共享目录中。
