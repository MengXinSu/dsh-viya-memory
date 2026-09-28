# viya-memory

> **给 DeepSeek Harness 的本地长期记忆 —— 卡片就是 Markdown 文件，存在你自己的 Obsidian vault 里。**

![tests](https://img.shields.io/badge/tests-140%20passing-brightgreen) ![deps](https://img.shields.io/badge/deps-zero-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

一个 DSH host 插件：**单文件、零构建、零外部依赖**（只用 DSH 自带的 `@deepseek-ai/schemastery`），
提供七个记忆工具，卡片以 **Markdown + YAML frontmatter + `[[]]` 双链** 落盘。

```
save · search · read · update · link · forget · stats
```

<sub>**English:** A local long-term memory plugin for DeepSeek Harness. Cards are plain Markdown files in
*your own* Obsidian vault — graph, backlinks, search and manual editing come for free.
Seven model-facing tools, no database, no background process, no lock-in.</sub>

---

## 亮点

- **数据是你的**：卡片就是 `.md` 文件，Obsidian 打开就能看、能改、能看图谱。不锁死在任何应用里。
- **关系白送**：`memory_link` 往两张卡**各写一条** `[[双链]]`，要么两边都写、要么都不写，不留单向边。
- **不怕误删**：删除是**两步**的——不带 `confirm: true` 只返回预览，一个字节都不动；默认软删进 `_trashed/`。
- **不覆盖你的手改**：写入前比对 mtime，你在 Obsidian 里改过的卡不会被旧内容冲掉；你手写的 `aliases`、`cssclasses` 等字段逐字保留。
- **不让密钥入库**：正文、标题、tags、keywords、关系说明命中密钥特征就拒绝写入（库常常会同步到网盘 / 手机）。
- **关得住**：`save` / `update` / `link` / `forget` 只认库内，路径穿越、junction 绕路都会被拒。
- **调用即走**：没有定时器、子进程、监听，不驻留后台；写入原子（临时文件 → rename）。1000 张卡时单次调用约 50–100ms。

## 安装

```sh
dsh plugin --profile <你的 profile 名> add github:MengXinSu/dsh-viya-memory
```

装完**必须**配置 `library`，否则第一次调用会直接报错——这是刻意的，免得卡片被静默写进意外目录。
host 插件改动后需**重启 DSH** 才生效。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: viya-memory
  name: viya-memory
  config:
    # 必填：你的 Obsidian vault 绝对路径
    library: '/home/you/Obsidian/MyVault'      # Windows: 'D:\Obsidian\MyVault'
```

| 键 | 默认 | 说明 |
|---|---|---|
| `library` | （必填） | vault 绝对路径 |
| `userFile` | `<vault>/user.md` | 常驻 system prompt 的那份文件 |
| `softLimit` | `1000` | 正文软限（字），超了只提示、不拦 |
| `hardLimit` | `4000` | 正文硬限（字），超了报错 |
| `searchBudget` | `2000` | 检索结果总字符预算，超出的条目降级为截短摘要 |
| `sensitiveScan` | `true` | 写入前扫描密钥特征 |

## 七个工具

| 工具 | 参数（**加粗**必填） | 行为 |
|---|---|---|
| `memory_save` | **`title`** · **`content`** · `kind` · `tags` · `keywords` · `importance` · `links` · `severity` · `occurred_at` | 新建一张卡；同名卡已存在时，内容高度重合就跳过，否则另起 `## 更新 YYYY-MM-DD` 一节追加。正文里的本地图片搬进 `_assets/` 并原地改写引用 |
| `memory_search` | **`query`** · `limit` · `tags` · `threshold` · `start_time` · `end_time` | 返回标题 + 路径 + 标签 + 摘要。空格或 `\|` 分关键词（AND），`*` 通配，只传 `*` 返回全部；默认 10 条、无上限 |
| `memory_read` | **`title`** 或 **`path`** | 全文 + `status` / `updated` / `links` + 附件绝对路径；找不到时附最多 3 个相近标题 |
| `memory_update` | **`title`** · `content` · `tags` · `status` · `importance` · `keywords` · `occurred_at` | 给哪个改哪个，`created` 不动、`updated` 自动刷新 |
| `memory_link` | **`source`** · **`target`** · `type` · `weight` · `description` | 两张卡各写一条关系边（`related` / `causes` / `explains` / `part_of` / `contradicts`） |
| `memory_forget` | **`title`** · `confirm` · `permanent` | 两步删：先预览（删哪张、谁引用了它），`confirm: true` 才软删；`permanent: true` 真删，同样要确认 |
| `memory_stats` | 无 | 只读体检：卡数 / 分布 / 超长卡 / 死链 / 库外链接 / 重名卡 / 回收站 |

## `user.md`：唯一常驻 prompt 的东西

`<vault>/user.md` 会被注入 system prompt 末尾——这是插件唯一常驻上下文的部分，只放**低频变化**的东西：
称呼、禁忌、偏好。它由**你手写**，插件不提供写入工具（模型不该有权改你的规矩）。改完下一轮对话生效。

## 目录结构

```
<你的 vault>/
├── user.md              # 常驻 prompt（你手写）
├── 03-Knowledge/        # 默认目录（可建子文件夹，最深 8 层）
├── 02-Projects/ 04-Content/ 05-Prompts/ 06-Business/ 07-Tools/ 08-Mistakes/
├── _assets/<卡片名>/     # 卡片引用的图片
└── _trashed/            # 软删的卡（恢复 = 拖回原目录）
```

`kind` 走三道闸匹配目录（精确 → 归一化 → 互为子串），都不中才新建 `NN-slug` 一级目录并在返回里报备。
`_` / `.` 前缀目录（`_trashed`、`_assets`、`.git`、`.obsidian`）是保留区，不算卡目录。

<details>
<summary><b>行为细则</b>（几个不写下来一定会踩的地方）</summary>

- **标签与关键词**：`tags: [a, b]` 与标量 `tags: a` 都认；值里可带逗号（序列化自动加引号）、换行会压成空格。关键词中英文逗号都算分隔。
- **frontmatter 兼容**：认行尾注释 `# …`、块标量 `|` / `>`、CRLF、BOM；`status` 大小写不敏感。
- **文件名只是存储**：Windows 非法字符（`* : ? / \ " < > |`）转成全角同形字，文件名可读；按字节截断到 150；撞名自动让位成 `名-2.md`。判重看标题，不看文件名。
- **路径口径**：相对路径以**库根**为基准（与 Obsidian 一致）。`memory_read` 可读库外文件（看附件用）；其余工具只认库内。路径形式的 `title` 只能写进卡目录或其子目录。
- **回收站**：`save` / `update` / `link` 看不见回收站里的卡；往已标 `deleted` 的同名卡追加会报错，要先改回 `approved` 或换标题。
- **边的来源**：frontmatter `links` 是声明过的边；正文里的 `[[X]]` 是派生边，不写回 frontmatter（正文删掉就没了）；`![[嵌入]]` 不算边；同目标同类型只留一条。换 `type` 会把 `weight` / `description` 重置为默认值，除非同一次调用里显式给出。
- **删除预览的引用数**按 Obsidian 口径：标题、文件名、目录前缀、锚点 / 别名都认，大小写不敏感。
- **图片**：只搬明确的图片扩展名；代码块和行内代码里的图片语法不算图片；同名不同内容的图另起名字，不覆盖。
- **追加更新**：`kind` 跟着卡的实际目录走；传了 `occurred_at` 就采用，不传保留原值。

</details>

## 测试

```sh
node --test tests/selftest.mjs
```

**140 项，全部走真实执行路径**（mock 一个 ctx 调 `apply()`，捕获实际注册的工具再真的调用）：frontmatter 往返、
slug 与撞名、kind 三道闸、长度闸、敏感扫描、图片搬运、检索与预算降级、七个工具的完整行为、路径夹取与
junction、删除硬闸、`user.md` 注入，以及真文件系统端到端冒烟。

大部分用例是**被测出来的 bug 反向补的回归**；关键修复都做过变异验证（故意改坏 → 确认测试报警 → 恢复比对哈希）。

## 踩过的两个坑

1. **cordis 的服务访问必须先声明 `inject`。** `apply()` 用了 `ctx.systemPrompt` 却没写进 `inject`，插件**整条不激活**——不报错，只是一个工具都没注册。mock 的 `ctx` 是普通对象，自测全绿也抓不到。
2. **schemastery 的 `.volatile()` 字段是盒子对象。** 解析后是 `{ get() }` 而不是值：`String(库路径)` 得到 `"[object Object]"`，数字阈值全变 NaN 比较、静默失效。

两条都补成了防复发自测。

## 碎碎念

调研了 23 款现成的记忆插件，然后忘了当初为什么要调研 —— 直接自己写了一个。

—— viya

## 致谢

感谢 **Ww** 为本项目的开发与测试提供了模型支持。

## License

MIT
