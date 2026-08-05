# Git 文章版本管理设计

日期：2026-08-05
状态：已确认设计，待实现计划

## 1. 目标与范围

Mythpen 为每个项目提供基于 Git 的文章版本管理，让作者和 AI 能够查询文章改动、创建本地存档点、查看章节历史，以及安全地恢复某个历史版本。

第一版只提供后端能力和 AI 工具协议：不新增“版本与协作”页面、侧栏入口或专用状态栏。现有聊天或外部调用方通过受控工具获得结果。

第一版仅支持本地 Git 仓库。远端 `fetch`/`push`、分支工作流、章节认领和多人同步是后续阶段，不属于本设计的实现范围。

## 2. 已确认的产品决策

- 正文不再以 SQLite 作为唯一权威来源；每章 Markdown 文件和版本化清单构成 Git 管理的文章权威层。
- Git 管理卷/章节结构、标题、大纲、章节状态、五个叙事维度和章节正文。
- SQLite 保留本机投影与不进入第一版 Git 范围的数据：角色、世界观、时间线、AI 会话、AI 待审修订、统计和界面状态。
- 自动保存只写 Git 工作区中的文章文件，绝不自动创建 Git commit。
- 作者或 AI 在获得用户明确授权后，才可创建本地存档点或恢复历史内容。
- 同一章节暂不支持多人同时编辑；第一版遇到外部改动与本地草稿并存时阻断写入并保留草稿，不做内置三方合并。

## 3. 为什么不能复用现有导出

当前 Markdown 导出从 SQLite 读取全书章节，拼成一个单独的展示/发布文件，附带卷标题和统计尾注；它没有反向导入契约。把该导出文件提交到 Git 会导致正文、章节结构和 SQLite 状态出现双主问题。

当前正文还会经人工编辑、REST 章节 CRUD、AI 工具循环、AI 续写和 AI 润色接受等多条路径直接写入 `chapters.content`。迁移后这些路径必须经同一个章节仓储服务，不能在既有 SQL 写入后补一个异步导出步骤。

## 4. 权威数据与仓库格式

每个 Git 文章仓库使用以下受控目录；Mythpen 只读写 `mythpen/` 及根目录的受控 `.gitattributes`、`.gitignore`。

```text
<repository>/
  mythpen/
    manuscript.json
    volumes/
      vol_<volume_uid>/
        index.json
        chapters/
          ch_<chapter_uid>.md
  .gitattributes
  .gitignore
```

`manuscript.json` 包含格式版本、不可变 `project_uid`、卷 UID 和卷目录映射。每个 `index.json` 包含卷标题、摘要、顺序和章节顺序，以及该卷每章的标题、大纲、状态、摘要和五个叙事维度。每个 `ch_<chapter_uid>.md` 只包含该章节的 Markdown 正文。

`chapter_uid` 和 `volume_uid` 必须是跨设备、跨克隆稳定的 UUID；不得使用当前本机 SQLite 自增的 `chapters.id`、`volumes.id`、章节号、标题或文件名作为协作身份。SQLite 可保留本地整数 ID 和外键，并保存 UID 到本地 ID 的映射。

所有 JSON 使用稳定键顺序、UTF-8 无 BOM 与 LF 换行；`.gitattributes` 固定文本换行。`word_count`、`updated_at` 和其他可推导或高频变化字段不写入权威文件，以减少无意义 diff。

第一版定义受支持的 Markdown 子集，并在读写时校验。由于当前编辑器会规范化有限的 Markdown 语法，不能承诺任意外部 Markdown 往返后字节不变。

## 5. 服务架构

```text
编辑器 / REST 章节 API / AI 工具 / AI 续写与润色接受
                         |
                         v
                ManuscriptService
                 /        |        \
                v         v         v
        ManuscriptStore  SQLite    GitService
        (清单与章节)     投影     (受控 Git 命令)
```

### 5.1 ManuscriptStore

负责清单与章节文件的解析、模式校验、稳定序列化、原子写入、内容哈希和工作区重建。文件先写入临时路径并原子替换；清单只在其引用的章节文件均已发布后更新。

### 5.2 ManuscriptService

是卷和章节的唯一业务读写入口。REST API、AI tools、续写、润色接受、删除和导出都调用它，不再直接更新 `chapters.content`。它更新 Markdown 权威层后，在 SQLite 事务中刷新本机投影、字数和 UID 映射。

`data_version` 继续用于同一设备多窗口的乐观并发控制；它不是 Git 历史，也不能用于判断 Git 工作区是否发生了外部变更。

### 5.3 SQLite 投影

SQLite 仍为现有页面、关联表和 AI 待审修订提供本机查询能力；它可以缓存当前正文，但该副本始终是 Git 工作区文件的派生投影。Git 工作区发生接受的外部变化或崩溃恢复时，系统以清单和章节文件为准重建相关投影。

`chapter_revisions` 保持为本机待审 AI 操作状态。提案未接受前不进入 Git；接受后的正文通过 `ManuscriptService` 写入工作区，随后可被纳入存档点。

### 5.4 GitService

只封装固定子命令：`status`、`diff`、`log`、`init`、路径受限的 `add`、`commit` 和章节级 `show`。第一版不实现远端命令。

Git 通过 `spawn`/`execFile` 传递固定参数，禁止 shell 字符串拼接。服务在每次调用前验证仓库真实路径、受控目录包含关系与符号链接/重解析点风险；永不执行 `git add .`、不读取或保存 Token/SSH 私钥、不自动修改全局 Git 配置。仓库须经调用方明确标记为可信；每次 Git 调用都以进程级 `core.hooksPath` 指向应用管理的空目录，提交同时带 `--no-verify`，从而不执行仓库 hook。

仓库初始化、已有 SQLite 项目的迁移和本地仓库路径绑定属于受信任的本地管理能力（CLI 或受保护后端管理接口），不属于 AI tools。AI 仅能操作已绑定、已通过路径校验且已被调用方标记可信的仓库，因此无法用工具参数选择任意目录。

## 6. AI 工具协议

AI 只获得领域工具，不获得任意 Git 命令、文件路径或仓库路径。

### 6.1 只读工具

- `get_manuscript_status(project_uid)`：返回当前 HEAD、受控文件的工作区状态和未存档章节 UID。
- `list_changed_chapters(project_uid)`：返回各章节的变更类型与摘要。
- `get_chapter_history(project_uid, chapter_uid, limit)`：返回该章节相关的 commit 摘要。
- `get_chapter_diff(project_uid, chapter_uid, from_ref, to_ref)`：返回受限长度的章节 diff/摘要；两个引用只能是此前只读工具返回的 HEAD 或完整 commit ID。

### 6.2 两步变更工具

- `prepare_checkpoint(project_uid, chapter_uids, message)`：flush 目标草稿，生成将被暂存的受控文件、预期 HEAD、diff 摘要与操作摘要哈希；不改变 Git 状态。
- `create_checkpoint(project_uid, approval_token)`：校验令牌后暂存预览中固定的文件并创建本地 commit。
- `prepare_restore(project_uid, chapter_uid, source_ref)`：生成章节恢复预览和操作摘要哈希；不改变工作区。`source_ref` 只能是历史工具刚返回的完整 commit ID。
- `restore_chapter_version(project_uid, approval_token)`：校验令牌后将历史正文写到工作区和 SQLite 投影；它产生未存档变更，须通过独立存档点形成恢复 commit。

令牌由调用方在用户明确确认后经独立的 `ApprovalService` 签发，AI tools 命名空间没有签发令牌的能力。令牌为一次性、短时有效，并绑定 `project_uid`、操作类型、允许章节 UID、预期 HEAD、操作摘要哈希和调用方身份。验证失败、HEAD 改变、摘要不一致或令牌重复使用时，所有变更操作必须拒绝执行。

## 7. 用户可感知流程（无新页面）

1. 作者或 AI 编辑章节，现有自动保存将文本写入 Git 工作区；此时状态仅为“已保存到文章文件”。
2. AI 可查询工作区状态和 diff，说明哪些章节尚未存档。
3. 用户要求创建存档点后，AI 先调用 `prepare_checkpoint` 并展示变更摘要。
4. 用户明确确认，调用方签发批准令牌；AI 调用 `create_checkpoint`。
5. 服务器创建带规范化消息和 trailers 的本地 commit，例如：

   ```text
   manuscript: 完成 ch_<uid> 初稿

   Mythpen-Project: <project_uid>
   Mythpen-Chapters: ch_<uid>
   Mythpen-Checkpoint: true
   ```

6. 查询历史或恢复时，AI 先预览再请求确认。恢复绝不运行 `reset`、`checkout --` 或任何重写共享历史的命令。

## 8. 迁移与恢复

现有 SQLite 项目启用 Git 文章层时：受信任管理能力先绑定经验证的本地仓库根目录；随后暂停自动保存和 AI 写入、flush 数据库、从一致快照生成临时仓库内容、重新解析并比对章节 UID/数量/正文哈希，成功后发布受控目录并建立 SQLite UID 映射。原 SQLite 文件保留，不删除。

存在待审 AI 修订时，迁移必须要求用户先接受或拒绝；不得静默丢弃待审内容。

文件与 SQLite 无法形成跨资源 ACID 事务，因此以成功发布并校验的 Markdown 清单为正文提交点。系统保留简短操作日志；重启时如发现未完成操作，以清单和章节文件为准重建 SQLite 投影或恢复到上一份有效清单。

## 9. 非目标

- 远端 `fetch`/`push`、分支、Pull Request、GitHub/GitLab 登录与凭证管理。
- 同章节实时协作、CRDT、内置三方合并器和强制远端锁。
- Git 化角色、世界观、时间线、AI 会话与其他非章节创作数据。
- 自动 commit、任意 shell/Git 命令执行、对不可信仓库自动执行 hook。
- 使用 Git 二进制数据库文件作为正文版本载体。

## 10. 验收与测试边界

- 清单与章节的稳定序列化、往返解析、UTF-8/LF 和内容哈希测试。
- 每条现有正文写入路径都经 `ManuscriptService` 后生成相同的权威文件变化。
- UID 映射、章节创建/移动/删除、AI 润色接受、字数投影和同机 `data_version` 回归测试。
- 批准令牌的绑定、过期、一次性使用、HEAD 改变和摘要不匹配拒绝测试。
- 临时真实 Git 仓库中的 status、diff、commit、章节历史和安全恢复测试。
- 文件写入中断、SQLite 投影失败、格式非法、Git 缺失、Git 身份缺失与不可信路径的恢复/拒绝测试。

## 11. 实现前置条件

本设计批准后，先编写分阶段实施计划，再开始任何代码、数据库迁移或 API 改动。实施计划必须覆盖现有 REST、AI tools、AI 续写、AI 润色接受、编辑器自动保存和导出路径，避免形成 SQLite 与 Markdown 双主。
