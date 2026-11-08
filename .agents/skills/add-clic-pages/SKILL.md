---
name: add-clic-pages
description: 从 CLIC content list Excel 按 2nd_id 新增页面到本项目，并完成引用关系、分块、向量和检索验证。用于新增 CLIC 页面或导入新内容批次。
---

# 新增 CLIC 页面

在 repo 根目录执行命令。完成标准是指定页面已进入 `ClicPage`，引用已处理，分块已写入 `clic_chunks`，并能通过应用搜索检索到。

## 确认来源与范围

- 以用户指定的附件和编号范围为准。先读取工作簿表头和目标记录，核对文件版本及范围覆盖。
- Joyce 所说的 page number 指 **C 列 `2nd_id`**，不是 Excel 行号，也不是 Drupal `nid`。范围包含两端。
- `2nd_id` 用于选页；数据库用 `(nid, languageCode)` 唯一标识页面。记录本批次的 `2nd_id → nid → URL` 映射，用于后续核验。
- 导入器当前固定读取 `EN` sheet。`--lang` 只改变数据库语言标签，不能用它把 EN 内容当作中文导入；需要其他语言时先实现对应 sheet 与列映射。
- 区分新增与更新。新增批次使用 `--insert-only`，保留已存在页面、引用和分块。用户明确要求更新时才移除此参数。
- 缺少编号、内容或有效 URL 时，报告具体记录。完整批次需要完整附件；不要用网页推测 `2nd_id`，也不要默认为允许部分导入。

示例：2759–2973 应覆盖 215 个编号。旧文件 `CLIC Content List_20260924.xlsx` 最大编号为 2806，无法用于完整导入该批次。此范围只是历史示例，后续按当前任务选取。

## 检查导入计划

优先使用 [现有导入器](../../../scripts/upsert_clic_selection.py)，先阅读其参数及当前实现。它负责 HTML 转 Markdown、页面去重和引用解析。`pnpm upsert-clic` 会通过 uv 提供 openpyxl、markdownify；数据库访问还需要 `psql`。

数据库连接来自进程 `DATABASE_URL` 或 repo 根目录 `.env`。确认目标环境，沿用当前任务已授权的数据库范围；日志中保留数据库名称与环境即可，隐藏连接凭据。

```bash
pnpm upsert-clic --xlsx /path/to/content-list.xlsx --add-lo 2759 --add-hi 2973 --insert-only --summary --dry-run
```

检查以下结果后再 apply：

- 目标编号覆盖完整，插入数、已存在数与清单逐项核对。
- 被跳过的删除标记、删除线、空内容或无效 URL 均有解释。范围完整不代表所有记录都可导入。
- 引用解析中缺失的 CLIC 页面或 legislation cap/section 已被记录。判例引用目前只报告，不写入关联表。
- 引用 drop report 没有意外丢失。

导入器会在数据库访问前拒绝不完整的编号范围。其 dry-run 仍需要数据库连接来判断页面是否存在；没有连接时只能完成文件核查，不能宣称数据库检查通过。

## 写入页面和引用

使用与 dry-run 相同的附件、范围和语言参数：

```bash
pnpm upsert-clic --xlsx /path/to/content-list.xlsx --add-lo 2759 --add-hi 2973 --insert-only --summary --require-no-drop --apply
```

页面和引用在同一事务中写入。失败时检查错误并重跑同一批次。成功后重新 dry-run，新增页面数应为零。

引用关系的方向和匹配有项目特有约定，复用导入器即可：

- `_ClicPageRelationToClicPage` 的 A 是被引用页面，B 是引用者。
- legislation 按 `(cap, section)` 成对匹配，支持去除 section 前缀 `s`，缺少 section 时可回退到 cap。
- 对未解析的引用报告限制，不把提取数量当作成功写入数量。

## 生成搜索数据

先读 [README 数据流程](../../../README.md) 和以下脚本，确认运行范围及凭据来源：

| 阶段 | 现有脚本 | 使用前要确认 |
| --- | --- | --- |
| 分块 | `scripts/index-clic.ts` | 按语言读取全部 CLIC 页面，生成 `scripts/index-output/chunks-{lang}.json`；512 token、128 overlap、`o200k_base` |
| 向量 | `scripts/embed-clic-judgment.mjs` | 复用内容匹配的缓存和续跑 sidecar；除指定语言外也处理 sc/tc 和 judgment 文件 |
| 入库与索引 | `scripts/load-existing-chunks.mjs` | 读取多语言 CLIC 和 judgment JSON；judgment 文件当前为必需输入；冲突行保留原值，随后填充 tsv/CJK 并创建缺失索引 |

这三个脚本不是只处理本次新增页面的流水线。CLIC 单批任务中，先确认全量输入及处理范围都属于当前任务；否则给脚本增加明确的语言、nid 或语料范围选项后再运行。保留现有向量模型、维度和分块规则，使新旧数据兼容。

运行 TypeScript 分块器前确认本机 TS runner、Prisma 生成客户端和依赖已就绪。分块器需要进程中的 `DATABASE_URL`；向量和加载脚本当前会直接读取 repo 根目录 `.env`。不要假设给一个脚本设置环境变量就能满足全部阶段。

新分块必须具有完整 embedding 才能入库。缓存仅在文本一致时复用。`load-existing-chunks.mjs` 使用 `ON CONFLICT DO NOTHING`；它不会替换已存在的旧分块。若任务包括更新页面，导入器会清除这些页面的旧分块，需要完成重新生成和加载后才算更新完成。

## 验证与交付

用批次 nid 映射核对数据库，按语言限定所有查询：

1. 每个应导入页面均存在，标题、URL、正文与清单一致；报告过滤记录和保留的既有页面。
2. 每个新增且正文非空的页面都有分块；embedding 非空且维度匹配当前索引，tsv 已填充，中文任务另查 CJK tokens。
3. 对照导入日志核对实际引用关系，列出无法解析的目标。
4. 选取不同主题的新增页面，通过 `/clic-chat-hkulaw/api/clic/search` 的实际接口参数搜索，检查返回的 nid、语言和 URL。接口请求结构见 README 与路由实现。
5. 再次 dry-run 确认没有待插入项，核对本次任务未改变范围外页面。

交付时分别说明页面导入、引用、分块/向量入库、应用检索的完成状态。若缺附件、数据库权限、模型凭据或索引阶段失败，明确停在哪一步，保留批次映射和可复用日志。只写入页面表时应报告“页面已导入，尚未完成搜索索引”。
