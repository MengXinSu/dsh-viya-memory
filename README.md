# viya-memory

> **给 DeepSeek Harness 的本地长期记忆 —— 卡片就是 Markdown 文件，存在你自己的 Obsidian vault 里。**

一个 DSH host 插件：单文件、零构建、零外部依赖（只用 DSH 自带的 `@deepseek-ai/schemastery`），
提供七个记忆工具，卡片以 **Markdown + YAML frontmatter + `[[]]` 双链** 落盘。

```
save · search · read · update · link · forget · stats
```

<!-- 英文摘要 / English -->
<sub>**English:** A local long-term memory plugin for DeepSeek Harness. Cards are plain Markdown files in
*your own* Obsidian vault — so the graph, backlinks, search and manual editing come for free.
Seven model-facing tools, no database, no background process, no lock-in.</sub>

---

## 为什么又造一个记忆插件

DSH 生态里记忆类插件不少（我逐个读过 23 款的源码，统计了 189 个工具注册点），三条结论：

1. **事实标准骨架就是 `save / search / read / update / delete`** —— 和大家一样，没必要发明新范式；
2. **只有 2/23 家把「证据门」做成工具，没有任何一家把「关系」做得比自带双链更好**；
3. **自建的成本只有 ~700 行**，而装第三方插件要碰生产 profile。

所以这个插件的定位很明确：**不做数据库，做文件。**

## 设计上的几个取舍

| 决定 | 为什么 |
|---|---|
| 卡片 = Markdown + frontmatter | 你随时能用 Obsidian 打开、手改、看图谱；不锁死在某个应用里。数据是你的。 |
| 关系用 `[[]]` 双链 | 关系图是白送的，Obsidian 原生就认；`memory_link` 会往**两边**各写一条 |
| 三层长度闸 | 软限 1000 字提示 / 硬限 4000 字**报错** / 检索返回总预算 2000 字符。写入侧不轻易拦信息，超限说明该写文件 |
| 写卡时提炼 `keywords` | 「将来想不起该用什么词搜」是检索失败的头号原因，写卡时把同义词、缩写、中英对照埋进去 |
| 图片搬进 `_assets/<卡片名>/` | 卡片目录保持干净，Obsidian 的全局图谱里不会混进一堆图片节点；正文里的引用**原地改写**，位置一个字不动 |
| `memory_link` 要么两边都写、要么都不写 | 绝不留下「A 知道 B、B 不知道 A」的单向边 |
| 写入前比对 mtime | 你在 Obsidian 手改过的卡，不会被插件用旧内容覆盖 |
| 命中密钥特征就拒绝写入 | 库会同步（网盘 / 手机），明文密钥的泄露面比本地大 |

## 安装

```sh
dsh plugin --profile <你的 profile 名> add github:MengXinSu/dsh-viya-memory
```

装完**必须**配置 `library`（见下一节），否则第一次调用会直接报错提醒你——这是刻意的，
免得卡片被静默写进某个意外目录。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: viya-memory
  name: viya-memory
  config:
    # 必填：你的 Obsidian vault 绝对路径
    library: '/home/you/Obsidian/MyVault'      # Windows: 'D:\Obsidian\MyVault'
```

其余可选项（都有合理默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `userFile` | `<vault>/user.md` | 常驻 system prompt 的那份文件放哪 |
| `softLimit` | `1000` | 正文软限（字），超了只在返回值里提示，不拦写入 |
| `hardLimit` | `4000` | 正文硬限（字），超了报错并提示写文件或改用「卡 + 指针」 |
| `searchBudget` | `2000` | 检索返回的总字符预算 |
| `sensitiveScan` | `true` | 写入前扫描密钥特征 |

## 七个工具

| 工具 | 参数（**加粗**必填） | 行为 |
|---|---|---|
| `memory_save` | **`title`** · **`content`** · `kind` · `tags` · `keywords` · `importance` · `links` · `severity` · `occurred_at` | 拼 frontmatter、按 kind 选目录、slug 文件名、原子写、搬运正文里的本地图片 |
| `memory_search` | **`query`** · `limit` · `tags` · `threshold` · `start_time` · `end_time` | 返回标题 + 路径 + 摘要；`query` 支持 `\|` 分关键词（AND）与 `*` 通配 |
| `memory_read` | **`title`** 或 **`path`** | 正文全文 + `status`/`updated`/`links` + 附件绝对路径（不自动读图，图片 token 贵） |
| `memory_update` | **`title`** · `content` · `tags` · `status` · `importance` · `keywords` · `occurred_at` | 给哪个改哪个，`created` 不动、`updated` 自动刷新 |
| `memory_link` | **`source`** · **`target`** · `type` · `weight` · `description` | 两张卡各写一条 `[[]]`；两边都找得到才写 |
| `memory_forget` | **`title`** · `confirm` · `permanent` | **两步删**：不传 `confirm` 只返回预览（删哪张、谁引用了它、一个字节都不动）；`confirm: true` 才软删进 `_trashed/`；`permanent: true` 真删（同样要 confirm） |
| `memory_stats` | 无 | 只读体检：总卡数 / 分布 / 超长卡 / **死链** / 回收站 |

**撞名的处理是三岔口**，不是二选一：同名卡不存在就新建；已存在且新内容与旧内容高度重合（bigram 重叠 > 0.6）
就**跳过不写**（防止把同一件事记两遍）；真的在补充就**另起一节** `## 更新 YYYY-MM-DD`。

## `user.md`：唯一常驻进 system prompt 的东西

`<你的 vault>/user.md` 会被注入到 system prompt 的**末尾**（order 排在环境后缀之后）——这是整个插件唯一
常驻上下文的部分，所以只放**低频变化**的东西：称呼、禁忌、你的偏好。

它由**你手写**，插件不提供写入工具（模型不该有权改你的规矩）。改完下一轮对话就生效，不用重启。

## 目录结构

```
<你的 vault>/
├── user.md              # 常驻 prompt 的那份（你手写）
├── 03-Knowledge/        # 默认目录
├── 02-Projects/ 04-Content/ 05-Prompts/ 06-Business/ 07-Tools/ 08-Mistakes/
├── _assets/<卡片名>/     # 卡片引用的图片
└── _trashed/            # 软删的卡（想恢复就手动拖回去）
```

`kind` 参数走三道闸匹配目录（精确 → 归一化 → 互为子串），都不中才新建 `NN-slug` 一级目录，
并在返回里报备「已新建目录 `09-xxx`」。

## 测试

```sh
node --test tests/selftest.mjs
```

**127 项，全部走真实执行路径**：frontmatter 解析与往返（含标量写法与带逗号/引号/换行的值）、slug
与文件名撞车、kind 三道闸、三层长度闸、bigram 重叠判断、敏感信息扫描、图片识别与搬运、检索分组
与权重、七个工具的完整行为（撞名跳过 / 成节追加 / 单向边禁止 / mtime 冲突 / 软删回收站 / 体检死链 /
路径夹取 / **删除的 confirm 硬闸**）、`user.md` 注入，以及一个在系统临时目录里跑的真文件系统端到端冒烟。

其中相当一部分是**被测出来的 bug 反向补的回归用例**——标量标签、值里带换行、超长标题撞文件名、
相对路径越出库根、换关系类型继承旧权重，都在这一栏里。

## 行为细则（几个不写下来一定会踩的地方）

- **标签与关键词**：`tags: [a, b]` 是正路；`a, b` 这种标量写法也认。**值里可以带逗号**——序列化时会
  自动加引号（`['标签1,标签2']` 是一个标签，不是两个）。同理，值里的换行会被压成空格，不会把
  frontmatter 写成两行。
- **文件名只是存储**：标题 → 文件名的映射按**字节**截断（150 字节上限）。两个长标题即使截断后同名，
  也不会互相顶掉或误判「内容重合」——撞车时后者自动让位成 `名-2.md`。判重只看「同一张卡」，不看文件名。
- **路径口径**：卡内引用的相对路径、以及 `memory_read` 的相对路径，都以**库根**为基准（和 Obsidian
  一致），不看进程 cwd。`.md` 以外、又带非图片后缀的路径不会被当图片搬走。绝对路径照常可用。
- **能力边界**：`memory_read` 可以读**库外**文件（你要看附件绝对路径时会用到）；但
  `memory_forget` / `memory_save` / `memory_update` / `memory_link` 一律只认库内——删除和改写不会
  被一条参数带到库外去。
- **关系边**：目标 + 类型相同即视为「已有这条边」，再次调用跳过；**换 `type` 会把 `weight`/`description`
  重置成新类型的默认值（0.7 / 空）**，除非你在同一次调用里显式给出——旧关系的权重不该跟着新关系跑。
  缺省或空的 `weight`/`description` 则视为「没说」，不会覆盖已有边的值。
- **删卡是两步的**：`memory_forget` 不带 `confirm` 只返回**预览**（目标路径 + 有多少张卡引用了它），
  **一个字节都不动**；带 `confirm: true` 才真删。这不是啰嗦，是**防误删的硬闸**——规矩写在提示词里
  约束不住执行者（会读、会引用、仍然照删），只有参数级的闸门绕不过去。`permanent: true` 同样要确认。
- **软删是「搬到 `_trashed/`」，不是隐藏**。`_trashed/` 在库里面，Obsidian 照样看得见那些卡，
  `[[双链]]` 也不会断（指向的文件只是换了目录）。想恢复：把文件拖回原目录，或把 `status` 改回 `approved`。
- **回收站与保留目录隔离**：`_` / `.` 前缀目录（`_trashed`、`_assets`、`.git`、`.obsidian`）不是 kind，
  `kind: "trash"` 不会把卡写进回收站；`save` / `update` / `link` 看不见回收站里的卡（`read` 与永久删除除外）；
  往一张已标 `deleted` 的同名卡追加会报错，要先改回 `approved` 或换标题。
- **`memory_save` 的路径标题**只能落在库内**一级卡目录**（`03-Knowledge/x.md`），库外、库根、子目录、保留目录一律拒绝。
- **你手写的 frontmatter 字段**（`aliases`、`cssclasses`、插件字段……）任何写入都逐字保留。
- **边的来源**：frontmatter `links` 是声明过的边；正文里的 `[[X]]` 是派生边，只从正文读、不写回
  frontmatter（正文删掉就没了）；`![[嵌入]]` 不算关系边；同目标同类型的边只留一条。
- **删除预览的引用数**按 Obsidian 口径数：标题、文件名、目录前缀、锚点/别名都认，大小写不敏感。
- **关键词**中英文逗号都算分隔符；追加更新时 `kind` 跟着卡的实际目录走。

## 踩过的两个坑

1. **cordis 的服务访问必须先声明 `inject`。** `apply()` 里用了 `ctx.systemPrompt` 却没写进 `inject`，
   结果是插件**整条不激活**——不报错、不崩溃，只是七个工具一个都没注册。当时自测 61/61 全绿也抓不到，
   因为 mock 的 `ctx` 是个普通对象，谁访问它都不拦。
2. **schemastery 的 `.volatile()` 字段是盒子对象。** 解析后的值不是字符串而是 `{ get() }`，
   于是 `String(库路径)` 得到 `"[object Object]"`，卡片全写进了一个叫 `[object Object]` 的目录。
   更阴的是另外五个配置项：字数硬限、检索预算全变成 NaN 比较，**永远返回 false**——不报错，只是不生效。

两条都补成了防复发自测（静态扫描 `ctx.xxx` 与 `inject` 声明比对；拿真 schema 解析一次验类型）。

## 碎碎念

调研了 23 款现成的记忆插件，然后忘了当初为什么要调研 —— 直接自己写了一个。

—— viya

## License

MIT
