// viya-memory — 薇娅的本地记忆库插件（单文件 host 插件，零构建）
//
// 卡片以 Markdown + YAML frontmatter 存放在 Obsidian vault 里，用 Obsidian 当 UI
// （图谱、反链、手改全白送）。对外提供七个工具：save/search/read/update/link/
// forget/stats，外加把 user.md 注入 system prompt。
//
// 依赖纪律：只用 node 内置模块 + `@deepseek-ai/dsh-tools`（defineTool，运行时顺带
// 用模块声明挂上 ctx.tools）+ `@deepseek-ai/schemastery`（Config 表单）。刻意
// 不 import `@deepseek-ai/cordis` —— 加载期导入越少，未验证路径就越少。

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（= Loader entry id）。 */
export const name = 'viya-memory'

/** 依赖的工具服务：没有 tools 服务就别激活，避免在无工具 profile 里炸。 */
// ⚠️ cordis 的服务访问必须先声明 inject，否则 apply() 一碰就抛
// 「cannot get property "systemPrompt" without inject」——插件会整条不激活。
// 这里列出的必须是 apply() 里实际用到的**全部**服务：ctx.tools（注册七个工具）
// 与 ctx.systemPrompt（user.md 注入）。加新服务访问时必须同步加到这里。
export const inject = ['tools', 'systemPrompt']

// ───────────────────────── 配置 ─────────────────────────

/**
 * 解包 cordis/schemastery 的 volatile 盒子。
 *
 * `.volatile()` 字段（用途是让设置服务把字段投影成可编辑表单）解析后**不是普通值**，
 * 而是一个 `{ get(), [Symbol(cosmokit.volatile.write)]() }` 盒子 —— 值要用 `.get()` 取。
 * 直接当普通值读会出事：`String(box)` === "[object Object]"，`box > 800` 是 NaN 比较
 * （永远 false）。2026-09-27 实测踩过：卡片被写进 `<工作目录>\[object Object]\`，
 * 而且字数硬限、检索预算、user.md 路径全部**静默失效**。
 *
 * 用 getter 实时解包（不是一次性快照），所以设置服务改值后读到的仍是新值；
 * 非 volatile 的普通值原样通过 —— 两种形态都安全。
 * @param raw - cordis 交给 apply 的原始 config。
 * @returns 同形对象，值全部是普通值。
 */
function unwrapConfig(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => (value !== null && typeof value === 'object' && typeof value.get === 'function')
        ? value.get()
        : value,
    })
  }
  return out
}

/** 可编辑配置。除 library 外每字段 `.volatile()`（设置服务只把 volatile 字段投影成表单），
 *  读取一律经 {@link unwrapConfig} 解包。 */
export const Config = z.object({
  // library 刻意保持**普通字符串**：它是库根路径，写错就是整个库跑到别处去。
  // （加了 .volatile() 也能被 unwrapConfig 吃下，但这条路更不容易出错。）
  library: z.string().default(''),
  userFile: z.string().default('').volatile(),
  softLimit: z.number().step(1).min(50).default(1000).volatile(),
  hardLimit: z.number().step(1).min(100).default(4000).volatile(),
  searchBudget: z.number().step(1).min(200).default(2000).volatile(),
  sensitiveScan: z.boolean().default(true).volatile(),
})

/** 七个标准 kind：目录名 → 短名/别名。 */
const KINDS = [
  ['01-User', ['user', 'profile']],
  ['02-Projects', ['project', 'projects']],
  ['03-Knowledge', ['knowledge', 'know']],
  ['04-Content', ['content']],
  ['05-Prompts', ['prompt', 'prompts']],
  ['06-Business', ['business']],
  ['07-Tools', ['tool', 'tools']],
  ['08-Mistakes', ['mistake', 'mistakes', 'mistake-card']],
]

const DEFAULT_KIND = '03-Knowledge'
const TRASH_DIR = '_trashed'
const ASSETS_DIR = '_assets'
const LINK_TYPES = ['related', 'causes', 'explains', 'part_of', 'contradicts']
const SEVERITIES = ['debug', 'info', 'warn', 'error']
const STATUSES = ['approved', 'deleted']
/** memory_update 的正文编辑粒度：整段换 / 续写节 / 换节 / 精确替换 / 改标题。 */
const EDIT_MODES = ['replace', 'append', 'section', 'str', 'rename']
const FORMAT_VERSION = 1
const SUMMARY_CHARS = 150
const SHORT_SUMMARY_CHARS = 40
const DUP_THRESHOLD = 0.6
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'])

// ───────────────────────── 小工具 ─────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地日期 —— 绝不 toISOString（那是 UTC，晚上写卡会记成前一天）。 */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function localDateTime(d = new Date()) {
  return `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function unique(list) {
  return [...new Set(list.filter(s => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()))]
}

/**
 * 文件 slug：保留中英文数字，其余压成连字符；全空则回落 content。
 * 按**字节**截断而不是按字符：NTFS 的文件名上限约 255 UTF-16 字符，
 * 但中文一个字 3 字节，按字符截会顶到路径上限；同时把上限从 60 字提到 150 字节，
 * 免得两个长标题（前 60 字相同、后面不同）撞成同一个文件名——那会让第二张卡
 * 被当成「与既有卡高度重合」而静默拒写。
 */
function truncateByBytes(s, maxBytes) {
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > maxBytes) break
    out += ch
    bytes += size
  }
  return out
}

/**
 * Windows 文件名非法字符 → 全角同形字：原先一律压成 `-`，标题「把 * 翻成 .* 正则」落盘成
 * `把-翻成-.-正则`，在 Obsidian 里认不出原意（2026-09-28 工具调用测试）。全角字合法且保义，
 * 文件名更接近标题，Obsidian 按文件名解析的 [[双链]] 也更容易对上。
 * `#` `^` `[` `]` 是 Obsidian 链接语法字符，仍压成 `-`。
 */
const FULLWIDTH = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' }

function slugify(input, fallback = 'card') {
  const raw = String(input ?? '').trim()
    .replace(/[\\/:*?"<>|]/g, ch => FULLWIDTH[ch])
    .replace(/[#^[\]]+/g, ' ')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const cleaned = truncateByBytes(raw, 150).replace(/-+$/g, '')
  return cleaned.length > 0 ? cleaned : fallback
}

/** 同名文件已被别的标题占用时，让位成 `名-2.md`、`名-3.md`……（判重语义不能靠文件名撞车）。 */
function uniqueCardPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath
  const dir = path.dirname(basePath)
  const stem = path.basename(basePath, '.md')
  for (let i = 2; i <= 50; i += 1) {
    const next = path.join(dir, `${stem}-${i}.md`)
    if (!fs.existsSync(next)) return next
  }
  return path.join(dir, `${stem}-${Date.now()}.md`)
}

/**
 * 工具参数 keywords（逗号分隔字符串）→ 数组。中英文逗号都算分隔符：
 * 中文输入下写成 `记忆，插件` 很自然，原先只认 `,`，整串成了一个关键词（审查复现 B11）。
 */
function splitKeywords(raw) {
  return String(raw ?? '').split(/[,，]/)
}

function countChars(text) {
  return [...String(text ?? '')].length
}

/** 正文摘要：跳过标题/引用，压平换行，截 SUMMARY_CHARS 字。 */
function summarize(body) {
  const flat = String(body ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...flat]
  return chars.length <= SUMMARY_CHARS ? flat : chars.slice(0, SUMMARY_CHARS).join('') + '…'
}

/**
 * 把代码（围栏块 / 行内反引号）替换成**等长**空白，换行保留——位置不变，
 * 所以在遮罩文本上找到的下标可以直接用来切原文。
 * 找图片引用必须先遮罩：正文里写 `` `![[嵌入]]` `` 这种示例，原先会被当成真图片，
 * 报「图找不到」；示例恰好是真实路径时还会被搬进库、改写正文（2026-09-28 实测）。
 */
function maskCode(md) {
  const blank = s => s.replace(/[^\n]/g, ' ')
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/~~~[\s\S]*?~~~/g, blank)
    .replace(/`[^`\n]*`/g, blank)
}

function hasImage(body) {
  return /!\[[^\]]*\]\([^)]+\)|!\[\[[^\]]+\]\]/.test(maskCode(body))
}

/**
 * 是否本地图片路径（排除 URL 与库内 _assets）。
 * 扩展名白名单只在**明确给出扩展名**时生效：`![x](a.png)` 走真值判断，
 * `![x](附件/图)` 这类 Obsidian 常见写法（无扩展名）照旧当本地路径处理。
 * 原先这个白名单（IMAGE_EXT）定义完从没被用过，任何后缀都会被拷进库。
 */
function isLocalImagePath(p) {
  const s = String(p).trim()
  if (/^(https?|data|mailto|ftp|file):/i.test(s)) return false
  if (s.includes(`${ASSETS_DIR}/`) || s.includes(`${ASSETS_DIR}\\`)) return false
  // 后缀要「点 + 字母开头」才算扩展名（`v1.2` / `图.1` / `附件.名字` 不算，照旧放行）。
  // 不设长度上限——加了上限后，超长后缀（`a.verylongext`）会因为整体不匹配而被当成
  // 「无扩展名」放行，把「认不出来」误判成「本地图片」。点后面整段都要参与白名单判断。
  const m = /\.([A-Za-z][A-Za-z0-9]*)$/.exec(s)
  if (m !== null && !IMAGE_EXT.has(`.${m[1].toLowerCase()}`)) return false
  return true
}

/**
 * 图片引用路径落到磁盘上的真实文件：绝对路径按原样解析，其余一律以**库根**为基准。
 * 裸文件名（`a.png`）也走库根——原先它跟着 DSH 进程的 cwd 跑，导致同一个库里
 * 「裸文件名」和「带目录相对路径」两种口径，而 Obsidian 里两者都是相对 vault 根的。
 */
function resolveImagePath(rawPath, root) {
  const s = String(rawPath).trim()
  if (path.isAbsolute(s)) return s
  return path.join(root, s)
}

/** 一个 CSS 类无关的 JSON 结构 → 文本块。 */
function text(value) {
  return [{ type: 'text', text: value }]
}

// ───────────────────────── frontmatter ─────────────────────────

/** 单行化：YAML frontmatter 是逐行解析的，值里带真换行会直接把卡写坏（见 flattenLine 用途）。 */
function flattenLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/** 路径是否落在库内（库根自身算库内）。用于把「会搬走/改写文件」的工具关在库里。 */
function isInsideLibrary(p, root) {
  if (root === undefined) return true
  const abs = path.resolve(p)
  const base = path.resolve(root)
  return abs === base || abs.startsWith(`${base}${path.sep}`)
}

/**
 * 标签/关键词取值：数组是正路；标量也认——Obsidian 里手写 `tags: 技术` 或
 * `keywords: a, b` 都是很自然的写法，旧代码只认数组，这些卡一读就丢光整组元数据，
 * 而且下一次任何写入都会把字段彻底抹平。
 */
function asStringList(value) {
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return parseValueList(value).map(s => String(s).trim()).filter(Boolean)
  }
  return []
}

/** YAML 标量序列化：可裸写的裸写，否则单引号 + 转义。 */
function yamlScalar(value) {
  if (value === null || value === undefined) return "''"
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const s = flattenLine(value)
  if (s.length === 0) return "''"
  if (/^-?\d+(\.\d+)?$/.test(s) || /^(true|false|null|yes|no|on|off)$/i.test(s)) return `'${s}'`
  if (/^[\p{L}\p{N}][\p{L}\p{N}\s\-_./()（）·:：、]*$/u.test(s) && !/[:#]\s/.test(s) && !s.endsWith(':')) return s
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * 数组元素序列化：逗号是数组分隔符，所以**逗号必上引号**。
 * 往返 bug 的根因就在这里：`[标签1,标签2]` 落盘后，parseCard 的 split(',') 会把它
 * 当成两个元素，Obsidian 的 YAML 解析器同样如此——库内库外一起错。
 * 上下标里的 , 本来就在白名单里裸写（tags: [a, b]），去掉。
 */
function yamlItem(value) {
  const s = flattenLine(value)
  if (s.includes(',') || s.includes("'")) return `'${s.replace(/'/g, "''")}'`
  return yamlScalar(s)
}

/** 简单标量反序列化：剥引号、还原转义、识别数字与布尔。 */
function parseScalar(raw) {
  const s = String(raw).trim()
  if (s === '' || s === '~' || s === 'null') return undefined
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    const inner = s.slice(1, -1)
    return s.startsWith("'") ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"')
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

/** 分隔符探测：位置 i 是候选分隔符（`,` 或 `|`）时，返回其后一个非空字符。 */
function nextNonSpace(s, i) {
  for (let j = i + 1; j < s.length; j += 1) {
    if (s[j] !== ' ' && s[j] !== '\t') return s[j]
  }
  return undefined
}

/**
 * 流式 token 切分：引号内的逗号是内容，引号外的逗号才是分隔符。
 * 单引号里的 `''` 是转义的单引号（YAML 规则），不能当成收尾。
 * 这是往返一致性的关键：`['标签1,标签2', '说明, 带逗号']` 必须切回两个元素。
 */
function splitTokens(raw) {
  const s = String(raw ?? '')
  const out = []
  let buf = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      buf += ch
      i += 1
      while (i < s.length) {
        buf += s[i]
        if (s[i] === quote) {
          if (quote === "'" && s[i + 1] === "'") { buf += s[i + 1]; i += 2; continue }
          break
        }
        i += 1
      }
      continue
    }
    if (ch === ',') {
      const next = nextNonSpace(s, i)
      if (next === undefined) { buf += ch; continue }
      out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim().length > 0 || out.length === 0) out.push(buf.trim())
  return out
}

/** `[a, b]` / `['a,b']` / `[a, b]` → ['a', 'b'] */
function parseValueList(raw) {
  return splitTokens(raw)
    .filter(p => p.length > 0)
    .map(parseScalar)
    .filter(v => v !== undefined && String(v).trim().length > 0)
    .map(v => String(v).trim())
}

/**
 * `{target: x, type: explains, weight: 0.8, description: 说明}` → 对象。
 * 不能无脑 split(',')：description 里的逗号会把后面的字段吃掉（实测会丢 type），
 * 所以只在「逗号后面又是 `key:`」时才断开；带引号的值整段跳过。
 */
function parseInlineObject(raw) {
  const s = String(raw ?? '')
  if (!s.startsWith('{') || !s.endsWith('}')) return {}
  const inner = s.slice(1, -1)
  const parts = []
  let start = 0
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote !== null) {
      if (ch === quote) {
        if (quote === "'" && inner[i + 1] === "'") { i += 1; continue }
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === ',' && /^\s*[\w]+\s*:/.test(inner.slice(i + 1))) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))
  const out = {}
  for (const part of parts) {
    const kv = /^\s*([\w]+)\s*:\s*([\s\S]*?)\s*$/.exec(part)
    if (kv) out[kv[1]] = parseScalar(kv[2])
  }
  return out
}

/** 解析 `[[目标]]` / `[[目标|显示]]`，返回目标标题（可能带路径/锚点）。 */
function wikiTarget(inner) {
  const raw = String(inner).split('|')[0].split('#')[0].trim()
  return raw.replace(/\.md$/i, '').trim()
}

/**
 * 链接目标是否指向这张卡——口径与 Obsidian 一致：标题、文件名（basename）都认，
 * 带目录前缀时前缀必须与卡的实际位置吻合（`03-Knowledge/x`、`薇娅记忆库/03-Knowledge/x` 都行），
 * 大小写不敏感。锚点 `#` 与别名 `|` 已由 wikiTarget 剥掉。
 * 原先 forget 预览只比 `target === 标题`，按文件名 / 带路径写的引用全漏数
 * （2026-09-28 审查复现 B10：实际 3 张引用，预览报 1）。
 */
function linkPointsTo(target, card) {
  const raw = String(target ?? '').trim().replace(/\\/g, '/').replace(/\.md$/i, '')
  if (raw.length === 0) return false
  const lower = raw.toLowerCase()
  const title = String(card.title ?? '').toLowerCase()
  if (lower === title) return true
  const cardPath = String(card.path ?? '').replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase()
  const base = cardPath.split('/').pop() ?? ''
  if (!raw.includes('/')) return lower === base
  // 带路径：卡路径必须以「/目标」结尾（目录前缀逐段吻合），或目标末段就是标题且前缀吻合
  if (cardPath.endsWith(`/${lower}`)) return true
  const slash = lower.lastIndexOf('/')
  const dirPart = lower.slice(0, slash)
  const last = lower.slice(slash + 1)
  const cardDir = cardPath.slice(0, cardPath.lastIndexOf('/'))
  return last === title && cardDir.endsWith(`/${dirPart}`)
}

function normalizeLink(entry, keyField = 'type') {
  return {
    target: flattenLine(entry.target),
    [keyField]: flattenLine(entry[keyField] ?? 'related') || 'related',
    weight: Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 0.7,
    description: flattenLine(entry.description),
  }
}

/** 剥掉反引号行内代码与围栏代码块：里面的 `[[...]]` 是示例文本，不是真链接。 */
function stripCode(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/** 剥掉 YAML 行尾注释：引号外、前面是空白的 `#` 起到行尾。`a#b` 这种不带空白的 # 是内容。 */
function stripYamlComment(raw) {
  const s = String(raw ?? '')
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote !== null) {
      if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") { i += 1; continue }
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      // 只有值（或流式元素）开头的引号才算引号，词中的撇号是内容
      const prev = s.slice(0, i).trimEnd()
      if (prev === '' || /[[,{:]$/.test(prev)) quote = ch
      continue
    }
    if (ch === '#' && i > 0 && /\s/.test(s[i - 1])) return s.slice(0, i)
  }
  return s
}

/** serializeCard 自己会写的字段；其余字段都属于用户（或 Obsidian 插件），必须原样保留。 */
const KNOWN_FM_KEYS = new Set([
  'formatVersion', 'kind', 'title', 'tags', 'keywords', 'importance',
  'created', 'updated', 'status', 'severity', 'source', 'occurred_at', 'links',
])

/**
 * 收集未知 frontmatter 字段的**原始行**（含其缩进续行 / 块式列表项），写回时逐字带上。
 * 原先 serializeCard 只写它认识的字段，Obsidian 里手写的 `aliases`、`cssclasses`、
 * 各类插件字段在任何一次 update/link/forget 之后全部消失（2026-09-28 审查复现 B8）。
 * 存原始行而不是解析值：我们的 YAML 解析只是子集，解析再序列化会把没见过的写法改坏。
 */
function collectExtraFrontmatter(fmLines) {
  const extra = []
  let keep = false
  for (const line of fmLines) {
    const top = /^([^\s#-][^:]*?)\s*:(\s|$)/.exec(line)
    if (top) {
      keep = !KNOWN_FM_KEYS.has(top[1].trim())
      if (keep) extra.push(line)
      continue
    }
    // 续行：缩进行、`- 项`、空行、注释 —— 跟随所属字段
    if (keep) extra.push(line)
  }
  while (extra.length > 0 && extra[extra.length - 1].trim() === '') extra.pop()
  return extra
}

/**
 * 解析一张卡：frontmatter 字段 + 正文。
 * 正文里的 wiki 链接、frontmatter 里的 links、正向的 `links: [目标]` 都会并进 links。
 */
function parseCard(text_, filePath) {
  let raw = String(text_)
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  // 按行切并剥掉行尾 \r：CRLF 文件是 Windows 上的常态，留着 \r 会让所有
  // 行级正则（`^key: value$`）失配 —— `$` 不吃行尾的 \r，`.*` 又会把它吃掉。
  const lines = raw.split(/\r?\n/)
  let index = 0
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    index = 1
    while (index < lines.length && lines[index].trim() !== '---') index += 1
    index += 1
  }
  const hasFrontmatter = index > 1
  const fmLines = hasFrontmatter ? lines.slice(1, index - 1) : []
  const body = (hasFrontmatter ? lines.slice(index) : lines).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')

  const extraFrontmatter = collectExtraFrontmatter(fmLines)

  const fm = {}
  for (let i = 0; i < fmLines.length; i += 1) {
    const line = fmLines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    // 行尾注释 `key: 值 # 注释` 属于 YAML 注释，不是值（2026-09-28 边界探测 E5：原先整段读进 title/tags）
    const rest = stripYamlComment(m[2]).trim()
    // 块标量 `key: |` / `key: >`：值在后面的缩进行里（边界探测 E1/E2：原先读成字面量 "|"，
    // 写回时把真正的多行内容整段丢掉）
    const block = /^([|>])([+-]?)\d*$/.exec(rest)
    if (block) {
      const body = []
      let j = i + 1
      while (j < fmLines.length && (/^\s+\S/.test(fmLines[j]) || fmLines[j].trim() === '')) {
        body.push(fmLines[j])
        j += 1
      }
      while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
      const indent = Math.min(...body.filter(l => l.trim()).map(l => /^\s*/.exec(l)[0].length), Infinity)
      const stripped = body.map(l => l.slice(Number.isFinite(indent) ? indent : 0))
      fm[key] = block[1] === '|' ? stripped.join('\n') : stripped.map(l => l.trim()).join(' ').replace(/\s+/g, ' ')
      i = j - 1
      continue
    }
    if (rest === '') {
      // 块式列表：往后收 `  - 值`
      const items = []
      let j = i + 1
      while (j < fmLines.length && /^\s+-\s*/.test(fmLines[j])) {
        // 块式项同样要过 parseScalar 剥引号：`- '技术'` 原先连引号一起读成 `'技术'`
        // （2026-09-28 审查复现 B9）。统一回字符串，下游（links 的 `{...}`、标签）照旧处理。
        const value = parseScalar(stripYamlComment(fmLines[j].replace(/^\s+-\s*/, '')).trim())
        if (value !== undefined) items.push(String(value))
        j += 1
      }
      if (items.length > 0) {
        fm[key] = items
        i = j - 1
        continue
      }
      fm[key] = ''
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      // 元素可能被引号包住（逗号在值里），所以不能直接对整段 split(',')
      fm[key] = parseValueList(rest.slice(1, -1))
      continue
    }
    fm[key] = parseScalar(rest)
  }

  // links：`links:` 块式 - {target, type, weight, description} 或简单标量列表
  const links = []
  const rawLinks = fm.links
  if (Array.isArray(rawLinks)) {
    for (const item of rawLinks) {
      if (typeof item !== 'string') continue
      const s = item.trim().replace(/^-\s*/, '')
      if (s.startsWith('{') && s.endsWith('}')) {
        const obj = parseInlineObject(s)
        if (obj.target) links.push(normalizeLink(obj))
      } else {
        const target = parseScalar(s)
        if (typeof target === 'string' && target.length > 0) {
          links.push({ target, type: 'related', weight: 0.7, description: '' })
        }
      }
    }
  }
  // frontmatter 里完全相同（目标 + 类型）的边只留一条：历史上 save 追加会重复写同一条边
  // （2026-09-28 审查复现 B2），读的时候先去重，下次写回就自愈。
  const fmSeen = new Set()
  const deduped = links.filter((l) => {
    const key = `${l.target}\u0000${l.type}`
    if (fmSeen.has(key)) return false
    fmSeen.add(key)
    return true
  })
  links.length = 0
  links.push(...deduped)
  // 正文里的 wiki 链接也算关系（type 归 related），但 frontmatter 已声明的不重复。
  // 标 fromBody：它们**派生自正文**，serializeCard 不写回 frontmatter——否则正文删掉 [[X]]
  // 之后，这条边已被「冻结」在 frontmatter 里永远删不掉（审查复现 B3）。
  // `![[...]]` 是嵌入（图片/附件），不是关系边（审查复现 B4：图片被体检报成死链）。
  const seen = new Set(links.map(l => l.target))
  for (const m of stripCode(body).matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)) {
    const target = wikiTarget(m[1])
    if (target.length === 0 || seen.has(target)) continue
    seen.add(target)
    links.push({ target, type: 'related', weight: 0.7, description: '', fromBody: true })
  }

  const title = (typeof fm.title === 'string' && fm.title.trim()) || path.basename(String(filePath)).replace(/\.md$/i, '')
  const kindDir = String(filePath).split(/[\\/]/).slice(-2, -1)[0] ?? ''

  if (String(fm.kind ?? '').trim().length === 0) fm.kind = kindDir

  return {
    title: String(title).trim(),
    kind: String(fm.kind ?? '').trim(),
    tags: asStringList(fm.tags),
    keywords: asStringList(fm.keywords),
    importance: Number.isFinite(Number(fm.importance)) ? Number(fm.importance) : 3,
    created: String(fm.created ?? '').trim(),
    updated: String(fm.updated ?? '').trim(),
    // 大小写归一：手写 `status: Deleted` 原先不算删除、照样被搜到（边界探测 E8）
    status: String(fm.status ?? 'approved').trim().toLowerCase(),
    severity: String(fm.severity ?? 'info').trim(),
    source: String(fm.source ?? 'viya').trim(),
    occurred_at: String(fm.occurred_at ?? '').trim(),
    formatVersion: Number(fm.formatVersion ?? FORMAT_VERSION),
    links,
    extraFrontmatter,
    // aliases 解析成数组：Obsidian 靠它解析 `[[标题]]`，插件这边也得至少让 read 认旧标题——
    // rename 把旧标题留在 aliases 里，读不到就等于白留（手写的 `aliases: [a, b]` 一并认）
    aliases: readAliasBlock(extraFrontmatter).values,
    body,
    dir: kindDir,
    path: String(filePath),
  }
}

/** 组装 frontmatter + 正文。 */
function serializeCard(card) {
  const lines = ['---']
  lines.push(`formatVersion: ${card.formatVersion ?? FORMAT_VERSION}`)
  lines.push(`kind: ${yamlScalar(card.kind ?? '')}`)
  lines.push(`title: ${yamlScalar(card.title)}`)
  lines.push(`tags: [${(card.tags ?? []).map(yamlItem).join(', ')}]`)
  lines.push(`keywords: [${(card.keywords ?? []).map(yamlItem).join(', ')}]`)
  lines.push(`importance: ${Number.isFinite(Number(card.importance)) ? Number(card.importance) : 3}`)
  lines.push(`created: ${yamlScalar(card.created ?? localDate())}`)
  lines.push(`updated: ${yamlScalar(card.updated ?? localDate())}`)
  lines.push(`status: ${yamlScalar(card.status ?? 'approved')}`)
  lines.push(`severity: ${yamlScalar(card.severity ?? 'info')}`)
  lines.push(`source: ${yamlScalar(card.source ?? 'viya')}`)
  if (card.occurred_at) lines.push(`occurred_at: ${yamlScalar(card.occurred_at)}`)
  // 只写「声明过的」边：fromBody 的边由正文派生，正文就是它的唯一出处（B3）；
  // 目标 + 类型相同的只写一条（B2：save 追加会带进重复边）。
  const fmLinks = []
  const written = new Set()
  for (const link of card.links ?? []) {
    if (link.fromBody === true) continue
    const key = `${link.target}\u0000${link.type ?? 'related'}`
    if (written.has(key)) continue
    written.add(key)
    fmLinks.push(link)
  }
  if (fmLinks.length > 0) {
    lines.push('links:')
    for (const link of fmLinks) {
      lines.push(`  - {target: ${yamlScalar(link.target)}, type: ${yamlScalar(link.type ?? 'related')}, `
        + `weight: ${Number(link.weight ?? 0.7)}, description: ${yamlScalar(link.description ?? '')}}`)
    }
  } else {
    lines.push('links: []')
  }
  // 未知字段原样回写（见 collectExtraFrontmatter）；值里的换行已在行级保存，不再单行化。
  const extras = card.extraFrontmatter ?? []
  for (const line of extras) lines.push(line)
  // 自动补 aliases：文件名是 slug 版、title 是空格版，而卡的关系边按 title 记（frontmatter 的 links），
  // 少了 aliases，`[[标题]]` 在 Obsidian 里就解析不了——插件自己的死链判据认标题，
  // 所以从插件侧完全看不见这个问题（memory_stats 报 0 死链，Obsidian 里却点不开）。
  // 三条护栏：① 手写过 aliases 的卡绝不覆盖；② 标题含 | # [ ] 时跳过（那几种写在 [[ ]] 里本来就会被截断）；
  // ③ 想永久关掉这个行为的用户，手写一行任意 aliases 即可。
  const hasAliases = extras.some(line => /^aliases\s*:/.test(line))
  if (!hasAliases && card.title && !/[|#\[\]]/.test(card.title)) {
    lines.push('aliases:')
    lines.push(`  - ${yamlScalar(card.title)}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}${card.body ?? ''}\n`
}

// ────────────── 正文编辑 / 别名维护（memory_update 的 mode 用到） ──────────────

/** 去掉正文尾部的空白：serializeCard 会补一个 `\n`，这里别留出重复空行。 */
function trimTail(body) {
  return String(body ?? '').replace(/\s+$/, '')
}

/** 定位 `## 小节` 的范围：start=标题行，end=节内容结束（尾随空行不含）。找不到返回 null。 */
function sectionBounds(lines, want) {
  const isTarget = line => /^##\s+/.test(line) && line.replace(/^##\s+/, '').trim() === want
  const start = lines.findIndex(isTarget)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    // 节的边界是下一个 `#` / `##`；`###` 及更深算节内内容，不是边界
    if (/^#{1,2}\s+/.test(lines[i])) { end = i; break }
  }
  let tail = end
  while (tail > start + 1 && lines[tail - 1].trim() === '') tail -= 1
  return { start, end: tail }
}

/**
 * 按小节写正文——两条路共用一套边界判定：
 *   `replace` 整节换掉；`append` 续写在该节末尾。节不存在时都新建在正文末尾。
 */
function writeSection(body, heading, content, mode = 'replace') {
  const want = String(heading ?? '').trim()
  if (want.length === 0) throw new Error('section 不能为空')
  const text = String(content ?? '').replace(/\r\n/g, '\n')
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n')
  const bounds = sectionBounds(lines, want)
  if (bounds === null) {
    const base = trimTail(lines.join('\n'))
    const block = [`## ${want}`, ...text.split('\n')]
    return base.length > 0 ? `${base}\n\n${block.join('\n')}` : block.join('\n')
  }
  if (mode === 'replace') {
    const block = [`## ${want}`, ...text.split('\n')]
    return trimTail([...lines.slice(0, bounds.start), ...block, ...lines.slice(bounds.end)].join('\n'))
  }
  const addition = trimTail(text)
  const head = lines.slice(0, bounds.end)
  if (addition.length > 0) head.push(...addition.split('\n'))
  return trimTail([...head, ...lines.slice(bounds.end)].join('\n'))
}

/** 围栏/行内代码块的范围——里面的 `[[...]]` 是示例文本，改写引用时要绕开。 */
function codeRanges(md) {
  const ranges = []
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g
  let m = re.exec(md)
  while (m !== null) {
    ranges.push([m.index, m.index + m[0].length])
    m = re.exec(md)
  }
  return ranges
}

/**
 * 把正文里指向旧卡的 `[[旧]]` 改写成 `[[新]]`，`|别名` 与 `#锚点` 原样保留。
 * 代码块里的链接不动（它们不是真链接）。返回改了、处数。
 */
function rewriteWikiLinks(body, isTarget, newLabel) {
  const src = String(body ?? '')
  const ranges = codeRanges(src)
  let count = 0
  const out = src.replace(/\[\[([^\[\]\n]+)\]\]/g, (whole, inner, offset) => {
    if (ranges.some(([a, b]) => offset > a && offset < b)) return whole
    const head = inner.split('|')[0]
    // `#锚点` 与 `|别名` 各切各的：原先按 head.length 切尾巴，锚点连同目标一起被吃掉
    const hashAt = head.indexOf('#')
    const anchor = hashAt === -1 ? '' : head.slice(hashAt)
    const aliasAt = inner.indexOf('|')
    const alias = aliasAt === -1 ? '' : inner.slice(aliasAt)
    const target = (hashAt === -1 ? head : head.slice(0, hashAt)).trim().replace(/\.md$/i, '').trim()
    if (target.length === 0 || !isTarget(target)) return whole
    count += 1
    return `[[${newLabel}${anchor}${alias}]]`
  })
  return { body: out, count }
}

/** 读 extraFrontmatter 里的 aliases——块式（`aliases:` + `- x`）与内联（`aliases: [a, b]`）都认。 */
function readAliasBlock(extras) {
  const list = Array.isArray(extras) ? extras : []
  const start = list.findIndex(line => /^aliases\s*:/.test(line))
  if (start === -1) return { start: -1, end: -1, values: [] }
  const inline = list[start].replace(/^aliases\s*:/, '').trim()
  const values = []
  let end = start + 1
  if (inline.length > 0) {
    values.push(...parseValueList(inline).map(v => String(v).trim()))
  } else {
    while (end < list.length && !/^[^\s#][^:]*?\s*:(\s|$)/.test(list[end])) {
      const m = /^\s*-\s*(.+?)\s*$/.exec(list[end])
      if (m !== null) values.push(String(parseScalar(m[1]) ?? m[1]).trim())
      end += 1
    }
  }
  return { start, end, values: values.filter(v => v.length > 0) }
}

/**
 * 把 aliases 统一写成块式，并保证 values 都在里面（原有在前、新增在后、去重）。
 * 写在 extras 里而不是单开字段，是为了让 collectExtraFrontmatter 原样带回去——
 * 一旦这里写了 `aliases:`，serializeCard 的自动补就不再插手（手写优先）。
 */
function writeAliasBlock(extras, values) {
  const list = Array.isArray(extras) ? [...extras] : []
  const block = readAliasBlock(list)
  const merged = unique([...block.values, ...values.map(v => flattenLine(v)).filter(v => v.length > 0)])
  if (merged.length === 0) return list
  const lines = ['aliases:', ...merged.map(v => `  - ${yamlScalar(v)}`)]
  if (block.start === -1) return [...list, ...lines]
  return [...list.slice(0, block.start), ...lines, ...list.slice(block.end)]
}

/**
 * mode=rename：给一张卡改标题。
 *
 * 顺序有讲究——**先把新文件落盘、确认旧文件没被人动过、再删旧文件，最后才改引用者**。
 * 任何一步崩掉，最坏也只是「卡改名成功、部分引用还指着旧标题」，memory_stats 一眼报得出来；
 * 反过来（先删后写）中途挂掉就是直接丢卡。
 */
function renameCard(cfg, root, card, args) {
  const oldTitle = String(card.title ?? '')
  const newTitle = String(args.newTitle ?? '').trim()
  if (newTitle.length === 0) throw new Error('mode=rename 需要 newTitle')
  if (newTitle === oldTitle) throw new Error('newTitle 与现标题一样，不用改')
  if (cfg.sensitiveScan !== false) {
    const hit = scanSensitive(newTitle)
    if (hit !== null) throw new Error(`拒绝写入：新标题命中敏感信息（${hit}）。请改用脱敏版本重试。`)
  }

  const newPath = path.join(path.dirname(card.path), `${slugify(newTitle, 'card')}.md`)
  const samePath = path.resolve(newPath).toLowerCase() === path.resolve(card.path).toLowerCase()
  if (!samePath && fs.existsSync(newPath)) {
    throw new Error(`改名失败：${path.basename(newPath)} 已被占用（库里已有同 slug 的卡）。换个标题，或先处理那张卡。`)
  }
  // 新标题里带 | # [ ] 时写进 [[ ]] 会被截断，改用它落盘后的文件名当引用标签
  const linkLabel = /[|#\[\]]/.test(newTitle) ? path.basename(newPath, '.md') : newTitle

  // 旧标题留一个别名：库里已有的 `[[旧标题]]` 不会立刻变死链，Obsidian 那边也还点得开
  const next = {
    ...card,
    title: newTitle,
    extraFrontmatter: writeAliasBlock(card.extraFrontmatter, [newTitle, oldTitle]),
    updated: localDate(),
  }

  const stat = fs.statSync(card.path)
  if (samePath) {
    const written = atomicWrite(cfg, card.path, serializeCard(next), stat.mtimeMs)
    if (!written.ok) {
      throw new Error(`写入被拒绝：${card.path} 在本次调用期间被外部改动过（mtime 不一致），不覆盖。请重新读取后再改。`)
    }
  } else {
    const written = atomicWrite(cfg, newPath, serializeCard(next), undefined)
    if (!written.ok) throw new Error(`改名失败：新文件没写成（${newPath}）`)
    const after = fs.statSync(card.path)
    if (after.mtimeMs !== stat.mtimeMs) {
      try { fs.rmSync(newPath, { force: true }) } catch { /* 清不掉不致命，旧卡还在 */ }
      throw new Error('改名中途这张卡被外部改动过（Obsidian 手改？），已回滚，请重新读取再改。')
    }
    fs.rmSync(card.path, { force: true })
  }

  const changed = [`标题「${oldTitle}」→「${newTitle}」`]
  if (!samePath) changed.push(`文件 ${path.basename(card.path)} → ${path.basename(newPath)}`)

  // 全库改引用：正文里的 [[旧]] 与 frontmatter links 里声明式的 target
  const gone = { title: oldTitle, path: card.path }
  const isTarget = t => linkPointsTo(t, gone)
  const { cards } = scanLibrary(cfg, root, new Set(KINDS.map(([d]) => d)))
  const failures = []
  let referrers = 0
  for (const other of cards) {
    if (other === null || other.path === card.path || other.path === newPath) continue
    const wiki = rewriteWikiLinks(other.body, isTarget, linkLabel)
    const fmHits = (other.links ?? []).filter(l => l.fromBody !== true && isTarget(l.target))
    if (wiki.count === 0 && fmHits.length === 0) continue
    const links = (other.links ?? []).map(
      l => (l.fromBody !== true && isTarget(l.target)) ? { ...l, target: linkLabel } : l,
    )
    const updated = { ...other, body: wiki.body, links, updated: localDate() }
    try {
      const st = fs.statSync(other.path)
      const w = atomicWrite(cfg, other.path, serializeCard(updated), st.mtimeMs)
      if (!w.ok) { failures.push(other.title); continue }
      referrers += 1
    } catch {
      failures.push(other.title)
    }
  }
  if (referrers > 0) changed.push(`引用 ${referrers} 张已改链`)
  if (failures.length > 0) changed.push(`${failures.length} 张引用没改成：${failures.join('、')}`)

  return {
    title: newTitle,
    path: samePath ? card.path : newPath,
    words: countChars(next.body),
    changed,
    renamedFrom: oldTitle,
    referrers,
    referrerFailures: failures,
  }
}

// ───────────────────────── 库（vault）操作 ─────────────────────────

function libraryRoot(config) {
  const raw = String(config?.library ?? '').trim()
  if (raw.length === 0) throw new Error('viya-memory: 配置 library 为空')
  return path.resolve(raw)
}

function userFilePath(config) {
  const raw = String(config?.userFile ?? '').trim()
  return raw.length > 0 ? path.resolve(raw) : path.join(libraryRoot(config), 'user.md')
}

function trashRoot(config) {
  return path.join(libraryRoot(config), TRASH_DIR)
}

function assetsRoot(config) {
  return path.join(libraryRoot(config), ASSETS_DIR)
}

function ensureDirs(config) {
  const root = libraryRoot(config)
  fs.mkdirSync(root, { recursive: true })
  const kinds = new Set(KINDS.map(([dir]) => dir))
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !isReservedDir(entry.name)) kinds.add(entry.name)
  }
  return { root, kinds }
}

/**
 * 保留目录：`_` 前缀（_trashed / _assets 等插件自用）与 `.` 前缀（.git / .obsidian）。
 * 它们**不是 kind**：原先 ensureDirs 把库根下所有目录都当候选，`kind: "trash"` 经
 * matchKind 第三道「互为子串」直接命中 `_trashed`，卡被写进回收站、写入报成功、却永远搜不到。
 */
function isReservedDir(name) {
  return name.startsWith('_') || name.startsWith('.')
}

/** 列出一个目录下的 .md 卡（一层，不递归；跳过 _ 前缀目录）。 */
function listCardsIn(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    out.push(path.join(dir, entry.name))
  }
  return out
}

/** 子目录递归上限：防御异常深的目录树（正常库 2~3 层）。 */
const MAX_DEPTH = 8

/**
 * 递归列出一个卡目录（含子目录）下的 .md。
 * 原先只扫一层：在 Obsidian 里往 `03-Knowledge/子文件夹/` 放的卡，搜不到、体检也不报
 * （2026-09-28 交接遗留第 2 条）。每一层都跳过 `_` / `.` 保留目录；
 * 不跟随符号链接 / junction（Dirent.isDirectory() 对它们为 false）——防环、防被带出库。
 */
function listCardsDeep(dir, depth = 0) {
  const out = listCardsIn(dir)
  if (depth >= MAX_DEPTH) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || isReservedDir(entry.name)) continue
    out.push(...listCardsDeep(path.join(dir, entry.name), depth + 1))
  }
  return out
}

/** 扫描整个库（含回收站）。返回 {cards, trashed}。卡目录递归扫描，dir 记一级卡目录。 */
function scanLibrary(config, root, kinds) {
  const cards = []
  const trashed = []

  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    dirs = []
  }

  for (const dirName of dirs) {
    const full = path.join(root, dirName)
    if (dirName === TRASH_DIR) {
      for (const file of listCardsIn(full)) trashed.push(readCard(file))
      continue
    }
    if (isReservedDir(dirName)) continue
    for (const file of listCardsDeep(full)) {
      const card = readCard(file)
      // 子目录里的卡，归属仍是它所在的一级卡目录（体检分布、检索结果的 kind 都按这个）
      if (card !== null) card.dir = dirName
      cards.push(card)
    }
  }
  return { cards, trashed }
}

/** 文件相对库根的一级目录名（卡的 kind 归属）。 */
function topDirOf(root, filePath) {
  return path.relative(root, path.resolve(filePath)).split(/[\\/]/)[0] ?? ''
}

function readCard(file, root) {
  try {
    // 传了库根且给的是相对路径文件时，先按「库根为基准」找一遍
    // （绝对路径与裸文件名不受影响），跟 findCard 的相对路径口径保持一致。
    if (root !== undefined) {
      const raw = String(file)
      if (!path.isAbsolute(raw) && raw.includes('/')) {
        const abs = path.resolve(root, raw)
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) file = abs
      }
    }
    const stat = fs.statSync(file)
    return parseCard(fs.readFileSync(file, 'utf8'), file)
  } catch {
    return null
  }
}

/** 按标题/文件名找卡（先精确，再忽略大小写与路径形状）。 */
function findCard(config, root, query, options = {}) {
  const wanted = String(query ?? '').trim()
  if (wanted.length === 0) return null
  // 只有 memory_read 允许按「真实路径」把库外文件也读出来（它本来就要「详情/附件绝对路径」，
  // 读库外是它的既有能力）；其余工具一律只认库内——memory_forget 是会把文件搬走的，
  // memory_save/update 则会原地改写。
  const allowOutsideRead = options.allowOutsideRead === true
  // 回收站默认不可见：save/update/link 摸到 `_trashed/` 里的卡，会把内容写进一张
  // 永远搜不到的卡（2026-09-28 审查复现 B7/B12）。只有 read（看一眼无害）和
  // 永久删除（清回收站是正当需求）显式放开。
  const includeTrashed = options.includeTrashed === true || allowOutsideRead
  const rootAbs = root === undefined ? undefined : path.resolve(root)
  const insideLibrary = (p) => isInsideLibrary(p, root)
  // 落在保留目录（_trashed / _assets / .git …）里的路径：除回收站按 includeTrashed 放行外，一律不是卡。
  const inReserved = (p) => {
    if (rootAbs === undefined || !insideLibrary(p)) return false
    const segs = path.relative(rootAbs, path.resolve(p)).split(/[\\/]/)
    const head = segs[0] ?? ''
    if (head === TRASH_DIR) return !includeTrashed
    // 子目录也支持了，所以每一段目录都要查（03-Knowledge/.obsidian/x.md 同样是保留区）
    return segs.slice(0, -1).some(isReservedDir)
  }
  const pick = (p) => {
    // 夹取放在这里：`../x.md` 解析出来的绝对路径是真实存在的文件，
    // 不夹的话入口这一步就直接把它读走返回了，后面的候选集过滤根本轮不到。
    if (!allowOutsideRead && !insideLibrary(p)) return null
    if (!allowOutsideRead && inReserved(p)) return null
    try {
      if (!fs.statSync(p).isFile()) return null
      if (!p.toLowerCase().endsWith('.md')) return null
      const card = readCard(p)
      // 按路径直取的子目录卡：归属同样记一级卡目录，与 scanLibrary 口径一致
      if (card !== null && rootAbs !== undefined && insideLibrary(p)) card.dir = topDirOf(rootAbs, p)
      return card
    } catch {
      return null
    }
  }
  // 相对路径：读卡走 cwd（保持它原有的库外能力），其余工具以**库根**为基准。
  const candidate = path.isAbsolute(wanted)
    ? wanted
    : (allowOutsideRead || rootAbs === undefined ? path.resolve(wanted) : path.resolve(rootAbs, wanted))
  const hit = pick(candidate)
  if (hit !== null) return hit
  const { cards, trashed } = scanLibrary(config, root, new Set(KINDS.map(([d]) => d)))
  // 只认库内的卡：下面还有一层「按文件名匹配」，传 `../outside-probe.md` 时
  // 它的 basename 会跟库外那张卡撞上，把人放进来。
  const all = [...cards, ...(includeTrashed ? trashed : [])]
    .filter(c => c && (allowOutsideRead || insideLibrary(c.path)))
  const lower = wanted.toLowerCase()
  const byTitle = all.find(c => c.title === wanted)
    ?? all.find(c => c.title.toLowerCase() === lower)
  if (byTitle) return byTitle
  // 别名与标题同级：rename 之后用旧标题、或用户手写的 aliases，都该找得到（2026-10-01）
  const byAlias = all.find(c => (c.aliases ?? []).some(a => String(a).toLowerCase() === lower))
  if (byAlias !== undefined) return byAlias
  const base = lower.replace(/\.md$/, '').split(/[\\/]/).pop()
  return all.find(c => path.basename(c.path, '.md').toLowerCase() === base)
    ?? all.find(c => path.basename(c.path, '.md').toLowerCase() === slugify(wanted).toLowerCase())
    ?? null
}

/** kind 三道闸：精确 → 归一化 → 近似。都不中返回 undefined，由调用方建新目录。 */
function matchKind(rawKind, kinds) {
  const wanted = String(rawKind ?? '').trim()
  if (wanted.length === 0) return DEFAULT_KIND
  const norm = s => s.toLowerCase().replace(/[-_\s]+/g, '')
  const known = [...kinds]
  // 闸1 精确
  for (const dir of known) {
    const short = dir.replace(/^\d+-/, '')
    const aliases = KINDS.find(([d]) => d === dir)?.[1] ?? []
    if (dir === wanted || short === wanted || short.toLowerCase() === wanted.toLowerCase() || aliases.includes(wanted.toLowerCase())) {
      return dir
    }
  }
  // 闸2 归一化
  const nWanted = norm(wanted)
  for (const dir of known) {
    const short = dir.replace(/^\d+-/, '')
    const aliases = KINDS.find(([d]) => d === dir)?.[1] ?? []
    if (norm(dir) === nWanted || norm(short) === nWanted || aliases.some(a => norm(a) === nWanted)) return dir
  }
  // 闸3 近似（互为子串）
  for (const dir of known) {
    const short = norm(dir.replace(/^\d+-/, ''))
    if (short.length >= 3 && nWanted.length >= 3 && (short.includes(nWanted) || nWanted.includes(short))) return dir
  }
  return undefined
}

/** 建 `NN-slug` 一级目录（只一级）。 */
function createKindDir(root, kinds, rawKind) {
  let maxNumber = 8
  for (const dir of kinds) {
    const m = /^(\d+)-/.exec(dir)
    if (m) maxNumber = Math.max(maxNumber, Number(m[1]))
  }
  const slug = slugify(rawKind, 'misc')
  const dirName = `${pad2(maxNumber + 1)}-${slug.charAt(0).toUpperCase()}${slug.slice(1)}`
  fs.mkdirSync(path.join(root, dirName), { recursive: true })
  return dirName
}

/** 敏感信息扫描：命中即拒绝写入。返回命中的描述或 null。 */
function scanSensitive(content) {
  const text_ = String(content ?? '')
  const rules = [
    [/\bsk-[A-Za-z0-9_-]{16,}/, 'API key（sk- 前缀）'],
    [/\bas_sk_[A-Za-z0-9]{16,}/, 'API key（as_sk_ 前缀）'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
    [/\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]{40,}/, '私钥/公钥串'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM 私钥'],
    [/\b(?:api[_-]?key|secret|password|passwd|token|credential)s?\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{24,}/i, '密钥/口令赋值'],
  ]
  for (const [re, label] of rules) {
    if (re.test(text_)) return label
  }
  return null
}

/**
 * 多字段敏感扫描：字段值可以是字符串或字符串数组。命中返回 {field, label}，否则 null。
 * 正文之外的字段（标题 → 文件名、tags/keywords/links/关系说明 → frontmatter）同样会落盘同步。
 */
function scanSensitiveFields(fields) {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    const joined = Array.isArray(value) ? value.map(v => String(v ?? '')).join('\n') : String(value)
    const label = scanSensitive(joined)
    if (label !== null) return { field, label }
  }
  return null
}

/** 正文里所有本地图片引用：{start, end, rawPath}。 */
function findImageRefs(body) {
  // 在遮罩文本上找（代码里的示例不算），maskCode 等长，下标与原文一致
  const src = maskCode(body)
  const refs = []
  const md = /!\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = md.exec(src)) !== null) {
    const inside = m[1].trim()
    if (isLocalImagePath(inside)) refs.push({ start: m.index, end: m.index + m[0].length, rawPath: inside, syntax: 'md' })
  }
  const wiki = /!\[\[([^\]]+)\]\]/g
  while ((m = wiki.exec(src)) !== null) {
    const inside = m[1].split('|')[0].trim()
    if (isLocalImagePath(inside)) refs.push({ start: m.index, end: m.index + m[0].length, rawPath: inside, syntax: 'wiki' })
  }
  return refs.sort((a, b) => a.start - b.start)
}

/**
 * 把正文里的本地图片搬进 `<库>/_assets/<卡slug>/`，并原地改写引用路径。
 * 只在位置处替换路径本身，正文其他一个字不动。
 * @returns {{body: string, moved: string[], missing: string[], failed: string[]}}
 */
function relocateImages(config, cardSlug, body, root) {
  const src = String(body ?? '')
  const refs = findImageRefs(src)
  if (refs.length === 0) return { body: src, moved: [], missing: [], failed: [] }
  const targetDir = path.join(assetsRoot(config), cardSlug)
  const moved = []
  const missing = []
  const failed = []
  let out = ''
  let cursor = 0
  for (const ref of refs) {
    const rawPath = ref.rawPath
    // `![[a.png|说明]]` 里只搬路径部分，别名保留
    const [pathPart, aliasPart] = rawPath.split('|')
    const candidate = path.resolve(resolveImagePath(pathPart, root))
    let replacement = rawPath
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        missing.push(pathPart.trim())
      } else if (!IMAGE_EXT.has(path.extname(candidate).toLowerCase())) {
        // 真要**拷文件**时，扩展名必须明确在图片白名单里。原先无扩展名的路径也照拷——
        // `![k](C:/Users/x/.ssh/id_rsa)` 会把私钥复制进会同步的库（2026-09-28 安全测验 S1）。
        // 引用原样保留，不搬。
        failed.push(`${pathPart.trim()}（不是图片扩展名，不搬进库）`)
      } else {
        fs.mkdirSync(targetDir, { recursive: true })
        const fileName = path.basename(candidate)
        let dest = path.join(targetDir, fileName)
        let done = false
        if (fs.existsSync(dest)) {
          // 原先只比大小：同名同大小、内容不同的两张图会被当成「已搬过」，引用指向错图。
          // 逐字节比；不同就另起名字，绝不覆盖已有附件。
          if (fs.readFileSync(dest).equals(fs.readFileSync(candidate))) {
            done = true
          } else {
            const ext = path.extname(fileName)
            const stem = path.basename(fileName, ext)
            for (let i = 2; ; i += 1) {
              const next = path.join(targetDir, `${stem}-${i}${ext}`)
              if (!fs.existsSync(next)) { dest = next; break }
              if (fs.readFileSync(next).equals(fs.readFileSync(candidate))) { dest = next; done = true; break }
            }
          }
        }
        if (!done) {
          fs.copyFileSync(candidate, dest, fs.constants.COPYFILE_EXCL)
          moved.push(`${pathPart.trim()} → ${ASSETS_DIR}/${cardSlug}/${path.basename(dest)}`)
        }
        // 引用必须指向**实际落盘**的那个名字（撞名改名后是 `名-2.png`）
        const rel = `${ASSETS_DIR}/${cardSlug}/${path.basename(dest)}`
        replacement = aliasPart === undefined ? rel : `${rel}|${aliasPart}`
      }
    } catch (error) {
      failed.push(`${pathPart.trim()}（${error.message}）`)
    }
    out += src.slice(cursor, ref.start)
    if (ref.syntax === 'wiki') {
      out += `![[${replacement}]]`
    } else {
      out += `![${/!\[([^\]]*)\]/.exec(src.slice(ref.start, ref.end))?.[1] ?? ''}](${replacement})`
    }
    cursor = ref.end
  }
  out += src.slice(cursor)
  return { body: out, moved, missing, failed }
}

/** 原子写：临时文件 + rename 兜底；写入前校验 mtime 未被外人改过。 */
function atomicWrite(config, filePath, content, expectedMtimeMs) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  if (expectedMtimeMs !== undefined) {
    const current = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : undefined
    if (current !== expectedMtimeMs) {
      return { ok: false, reason: 'stale' }
    }
  }
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
  fs.writeFileSync(tmp, content, 'utf8')
  if (expectedMtimeMs !== undefined && fs.existsSync(filePath)) {
    const current = fs.statSync(filePath).mtimeMs
    if (current !== expectedMtimeMs) {
      try { fs.unlinkSync(tmp) } catch { /* 清不掉不致命 */ }
      return { ok: false, reason: 'stale' }
    }
  }
  fs.renameSync(tmp, filePath)
  return { ok: true }
}

/** 字符 bigram 相似度，用作「重叠率」。 */
function bigramOverlap(a, b) {
  const grams = value => {
    const chars = [...String(value ?? '').replace(/\s+/g, '')]
    const set = new Set()
    for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1])
    if (set.size === 0 && chars.length === 1) set.add(chars[0])
    return set
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit += 1
  return hit / Math.min(ga.size, gb.size)
}

// ───────────────────────── 检索 ─────────────────────────

/**
 * 解析 query：`|` 分多关键词（AND），词内 `*` 通配，单独 `*` 匹配全部。
 * @returns {{all: boolean, groups: string[][]}} 每个 group 是 term 的正则片段
 */
function parseQuery(query) {
  const raw = String(query ?? '').trim()
  if (raw.length === 0 || raw === '*') return { all: true, groups: [] }
  // 空格（含全角空格）与 `|` 一样是 AND 分隔符：模型和人都习惯「记忆 插件」这样写，
  // 原先只认 `|`，整串被当成一个字面量，稳定地搜不到（2026-09-28 工具调用测试）。
  const groups = raw.split(/[|\s\u3000]+/).map(part => part.trim()).filter(p => p.length > 0 && p !== '*')
  if (groups.length === 0) return { all: true, groups: [] }
  return { all: false, groups }
}

/**
 * 检索词 → 匹配器（不用正则）。
 * 原先把 `*` 翻成 `.*` 拼正则：`a*a*a*…*b` 对着 4000 字正文会**灾难性回溯**，
 * 一次 search 卡死整个进程（2026-09-28 安全测验 S5，3 分钟未返回）。
 * 现在按 `*` 切成若干段，逐行用 indexOf 顺序找——线性，没有回溯。
 * 语义与旧版一致：大小写不敏感、`*` 不跨行（旧正则没开 s 标志）。
 */
function termPattern(term) {
  const parts = String(term).toLowerCase().split('*').filter(p => p.length > 0)
  return { parts }
}

/** 在一行里从 from 开始找一次完整匹配，返回匹配结束位置或 -1。 */
function matchOnce(line, parts, from) {
  let pos = from
  for (const part of parts) {
    const at = line.indexOf(part, pos)
    if (at === -1) return -1
    pos = at + part.length
  }
  return pos
}

function countHits(haystack, pattern) {
  const parts = pattern.parts
  // 纯 `*` 组合（如 `**`）：旧正则 `.*.*` 每个字符串都命中一次
  if (parts.length === 0) return String(haystack ?? '').length > 0 ? 1 : 0
  let n = 0
  for (const line of String(haystack ?? '').toLowerCase().split('\n')) {
    let pos = 0
    while (pos <= line.length) {
      const end = matchOnce(line, parts, pos)
      if (end === -1) break
      n += 1
      if (n > 20) return n
      pos = end
    }
  }
  return n
}

/**
 * 打分：标题 ×3 / 关键词 ×2.5 / 别名 ×2.5 / 标签 ×2 / 正文 ×1 / 关系边 ×0.5。
 *
 * 多个关键词按 **OR 召回 + 至少命中一个**：命中就加分、不中就只当没听见。
 * 2026-10-01 之前是「任一组不命中即淘汰」，等于加词即自杀——实测 `撤回|收摊` 直接 0 命中，
 * 就因为「收摊」不在任何卡里。精度改由末尾 `total <= 0` 一条兜住：一个词都没命中才丢，
 * 完全不相干的卡照样进不来（不用去调一个玄学 threshold）。
 */
function scoreCard(card, parsed) {
  if (parsed.all) return { score: 1, hits: [] }
  let total = 0
  const hits = []
  for (const term of parsed.groups) {
    const pattern = termPattern(term)
    const titleHits = countHits(card.title, pattern)
    // 别名与关键词同档：别名是「曾用名」（rename 留下的旧标题，或手写的 aliases），
    // 认它，但不给它比现名更高的地位
    const aliasHits = countHits((card.aliases ?? []).join(' '), pattern)
    const tagHits = countHits(card.tags.join(' '), pattern)
    const kwHits = countHits(card.keywords.join(' '), pattern)
    const bodyHits = countHits(card.body, pattern)
    const linkHits = countHits(card.links.map(l => `${l.target} ${l.description}`).join(' '), pattern)
    const termScore = titleHits * 3 + aliasHits * 2.5 + tagHits * 2 + kwHits * 2.5 + bodyHits * 1 + linkHits * 0.5
    total += termScore
    if (termScore > 0) hits.push(term)
  }
  if (total <= 0) return null
  const importanceBonus = 1 + (Math.min(5, Math.max(1, card.importance)) - 3) * 0.05
  return { score: total * importanceBonus, hits }
}

function withinTime(card, startTime, endTime) {
  const at = card.occurred_at || card.created || ''
  const stamp = at.slice(0, 10)
  if (startTime && stamp.length > 0 && stamp < String(startTime).slice(0, 10)) return false
  if (endTime && stamp.length > 0 && stamp > String(endTime).slice(0, 10)) return false
  return true
}

// ───────────────────────── 工具输出 schema（Declared JSON Schema 子集）─────────

const summaryItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    path: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    updated: { type: 'string', required: true },
    score: { type: 'number', required: true },
    summary: { type: 'string', required: true },
    hasImage: { type: 'boolean', required: true },
    tags: { type: 'array', required: true, items: { type: 'string' } },
  },
}

const kindStatSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dir: { type: 'string', required: true },
    count: { type: 'integer', required: true },
  },
}

// ───────────────────────── 插件主体 ─────────────────────────

/**
 * 挂载七个记忆工具 + user.md 注入。
 * @param ctx - 插件上下文；所有注册都是它的 effect。
 * @param config - 已解析的 Config。
 */
export function apply(ctx, config) {
  // 必须先解包：volatile 字段是盒子对象，直接读会得到 "[object Object]" 和失效的阈值。
  const cfg = unwrapConfig(config)

  ctx.systemPrompt.section({
    name: 'viya-memory:user',
    order: 10300,
    // interpolate: false 是必须的：user.md 是你手写的自由文本，里面任何 `{{词}}`
    // 都会走 renderPrompt 的变量插值 —— 未注册的名字、或 `{{`/`}}` 不成对，都会
    // **直接抛错让整个 prompt 组装失败**（症状是整个会话跑不动）。这里只想要字面文本。
    interpolate: false,
    text: () => {
      try {
        const file = userFilePath(cfg)
        if (!fs.existsSync(file)) return ''
        const body = fs.readFileSync(file, 'utf8').trim()
        return body.length === 0 ? '' : body
      } catch {
        return ''
      }
    },
  })

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: [
      '写入一条长期记忆：把一条结论存成卡片（save），落到薇娅的本地记忆库（Obsidian vault 里的 Markdown）。',
      '',
      '一条记忆 = 一个结论。硬限 4000 字（超了报错）；软限 1000 字，超了只在返回的 action 里提示、不拦写入。',
      '卡里只写结论 + [[知识库里的文档]] 双链，全文归知识库。',
      '',
      '该记（SAVE）：用户明确说过的偏好/决定/禁忌；踩过的坑与根因；被否的方案及理由；项目关键约束；',
      '他亲口说的硬事实（生日这类只有他本人才写）。',
      '不该记（SKIP）：临时的中间过程、能从代码里直接读出来的事实、没被确认的推测、密钥与凭据。',
      '正文里出现本地图片路径会被搬进库内 _assets/ 并原地改写引用。',
      '新卡会自动补一行 aliases（= 标题），让 [[卡片标题]] 在 Obsidian 里可解析；手写过 aliases 的卡不动。',
    ].join('\n'),
    parameters: {
      title: { type: 'string', required: true, description: '卡片标题（也是文件名与双链目标）' },
      content: { type: 'string', required: true, description: '正文，一个结论，尽量 ≤ 1000 字（软限 1000 / 硬限 4000，软限超了只在返回值里提示）' },
      kind: { type: 'string', description: `目录类别，默认 ${DEFAULT_KIND}；可用短名 knowledge/mistakes/projects 等` },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，用于过滤与加权' },
      keywords: { type: 'string', description: '检索锚点，逗号分隔，建议 5-10 个（含同义词/缩写/中英对照）' },
      importance: { type: 'number', description: '重要度 1-5，默认 3' },
      links: { type: 'array', items: { type: 'string' }, description: '要关联的卡片标题列表' },
      severity: { type: 'string', description: `debug/info/warn/error，默认 info（教训卡用 warn/error）` },
      occurred_at: { type: 'string', description: '事情实际发生时间 YYYY-MM-DD（默认 = 记录日）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
          words: { type: 'integer', required: true },
          action: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(
        `【记忆已写入】${value.title}\n`
        + `路径：${value.path}\n`
        + `正文 ${value.words} 字 · ${value.action}\n`
        + 'Write saved — do not repeat.',
      ),
    },
    async execute(args) {
      const root = libraryRoot(cfg)
      const { kinds } = ensureDirs(cfg)
      const title = String(args.title ?? '').trim()
      const content = String(args.content ?? '').trim()
      if (title.length === 0) throw new Error('title 不能为空')
      if (content.length === 0) throw new Error('content 不能为空')

      if (cfg.sensitiveScan !== false) {
        // 元数据也扫：标题会变成文件名、tags/keywords 落在 frontmatter——原先只扫正文，
        // `title: 'key sk-…'` 照样把密钥写进库（2026-09-28 安全测验 S4）。
        const hit = scanSensitiveFields({
          正文: content, 标题: title, tags: args.tags, keywords: args.keywords, links: args.links,
        })
        if (hit !== null) {
          throw new Error(`拒绝写入：${hit.field}命中敏感信息（${hit.label}）。请改用脱敏版本重试。`)
        }
      }

      const hardLimit = Number(cfg.hardLimit ?? 4000)
      const words = countChars(content)
      const kindRaw = String(args.kind ?? '').trim()
      let kindDir = matchKind(kindRaw, kinds)
      let createdDir = null
      if (kindDir === undefined) {
        kindDir = createKindDir(root, kinds, kindRaw)
        createdDir = kindDir
      }

      const slash = title.includes('/') || title.includes('\\')
      const cardSlug = slugify(title, 'card')
      let filePath
      let existing = null
      if (!slash) {
        // 库内按「同 kind 目录同名」判重；再全库找一次同名卡，避免跨目录重名造成双链歧义
        const inKind = path.join(root, kindDir, `${cardSlug}.md`)
        const anywhere = findCard(cfg, root, title)
        if (fs.existsSync(inKind)) {
          const occupant = readCard(inKind)
          if (occupant !== null && occupant.title === title) {
            // 真的是同一张卡（标题一致）→ 走追加/跳过判重
            existing = occupant
            filePath = inKind
          } else {
            // 文件名被别的标题占了（slug 截断/大小写等）→ 让位，不能把两张不同的卡
            // 挤进一个文件然后判成「重合」把新的拒掉
            filePath = uniqueCardPath(inKind)
          }
        } else if (anywhere !== null && anywhere.status !== 'deleted' && anywhere.title === title) {
          existing = anywhere
          filePath = anywhere.path
        } else {
          filePath = inKind
        }
      } else {
        const candidate = path.isAbsolute(title) ? title : path.join(root, kindDir, `${cardSlug}.md`)
        filePath = candidate.toLowerCase().endsWith('.md') ? candidate : `${candidate}.md`
        // 绝对路径标题原先原样当落盘路径，能把卡写到库外（2026-09-28 审查复现 B6）。
        // save 与 update/link/forget 同一口径：只认库内，且不许落进 _ / . 保留目录。
        const rel = path.relative(root, path.resolve(filePath))
        if (!isInsideLibrary(filePath, root) || rel.length === 0) {
          throw new Error(`拒绝写入：路径 ${filePath} 不在记忆库内（${root}）。memory_save 只写库内。`)
        }
        const segs = rel.split(/[\\/]/)
        // 必须落在某个卡目录（可含子目录，深度不超过 MAX_DEPTH）里：库根不放卡；
        // 任何一段是 _ / . 保留目录都不行（scanLibrary 会跳过，写进去就搜不到）。
        const dirSegs = segs.slice(0, -1)
        if (dirSegs.length === 0 || dirSegs.length > MAX_DEPTH + 1 || dirSegs.some(isReservedDir)) {
          throw new Error(`拒绝写入：${filePath} 不在任何卡目录里（库根、_/. 保留目录、过深子目录都不放卡）。`)
        }
        if (fs.existsSync(filePath)) existing = readCard(filePath)
      }
      // 已标 deleted 的卡（update 改的 status，文件还在原目录）搜不到——往里追加等于写进黑洞
      // （2026-09-28 审查复现 B7）。不替人做「复活」决定：报错，让调用方显式恢复。
      if (existing !== null && existing.status === 'deleted') {
        throw new Error(
          `同名卡「${existing.title}」已标记为 deleted（${existing.path}），不往里追加——`
          + '要恢复请先 memory_update 把 status 改回 approved；要另起一张请换个标题。',
        )
      }
      // mtime 基线必须在这里取（读完旧卡之后立刻）：后面 relocateImages 要复制图片，
      // 可能耗时几十毫秒；基线取晚了就漏掉这段窗口里的外部改动，会用旧正文覆盖外部手改。
      const baselineMtime = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : undefined

      let finalBody = content
      let action = '新建'
      let wordsBefore = 0
      if (existing !== null) {
        const overlap = bigramOverlap(content, existing.body)
        if (overlap > DUP_THRESHOLD) {
          return {
            title: existing.title,
            path: existing.path,
            words: countChars(existing.body),
            action: `跳过：与既有卡内容高度重合（重叠率 ${overlap.toFixed(2)}），未写入`,
          }
        }
        const stamp = localDate()
        const appended = `${existing.body}\n\n## 更新 ${stamp}\n\n${content}`
        wordsBefore = countChars(existing.body)
        if (countChars(appended) > hardLimit) {
          throw new Error(
            `追加后正文会超过硬限 ${hardLimit} 字（原 ${wordsBefore} 字 + 新 ${words} 字）。`
            + '别无止境往上堆——内容该写成文件，或改用「卡 + 指针」。',
          )
        }
        finalBody = appended
        action = `追加更新节：原 ${wordsBefore} 字 → 现 ${countChars(appended)} 字`
      } else if (words > hardLimit) {
        throw new Error(
          `正文 ${words} 字，超过硬限 ${hardLimit} 字。这段内容不该塞进一张卡——写文件，或改用「卡 + 指针」：`
          + '卡里只写结论 + [[知识库里的文档]] 双链，全文归知识库。',
        )
      }

      const relocated = relocateImages(cfg, cardSlug, finalBody, root)
      const today = localDate()
      const card = existing !== null
        ? {
            ...existing,
            title,
            // 追加时 kind 跟着卡**实际所在目录**走：本次调用的 kind 可能是缺省值，
            // 原先会把 08-Mistakes 里的卡的 frontmatter 改成 03-Knowledge（审查复现 B1）。
            // 子目录里的卡取一级卡目录（03-Knowledge/子/x.md → 03-Knowledge）
            kind: topDirOf(root, filePath),
            tags: unique([...(existing.tags ?? []), ...(args.tags ?? [])]),
            keywords: unique([...(existing.keywords ?? []), ...splitKeywords(args.keywords)]),
            importance: Number.isFinite(Number(args.importance)) ? Number(args.importance) : existing.importance,
            severity: String(args.severity ?? existing.severity ?? 'info'),
            // 追加时显式给了 occurred_at 就采用（与 memory_update 同口径），没给则保留原值。
            // 原先追加路径直接忽略这个参数（2026-09-28 交接遗留）。
            occurred_at: typeof args.occurred_at === 'string' && args.occurred_at.trim().length > 0
              ? args.occurred_at.trim()
              : existing.occurred_at,
            links: [...existing.links, ...unique(args.links ?? []).map(t => ({ target: t, type: 'related', weight: 0.7, description: '' }))],
            body: relocated.body,
            updated: today,
          }
        : {
            formatVersion: FORMAT_VERSION,
            kind: kindDir,
            title,
            tags: unique(args.tags ?? []),
            keywords: unique(splitKeywords(args.keywords)),
            importance: Number.isFinite(Number(args.importance)) ? Number(args.importance) : 3,
            created: today,
            updated: today,
            status: 'approved',
            severity: String(args.severity ?? 'info'),
            source: 'viya',
            occurred_at: String(args.occurred_at ?? ''),
            links: unique(args.links ?? []).map(t => ({ target: t, type: 'related', weight: 0.7, description: '' })),
            body: relocated.body,
          }

      if (!SEVERITIES.includes(card.severity)) card.severity = 'info'

      const written = atomicWrite(cfg, filePath, serializeCard(card), baselineMtime)
      if (!written.ok) {
        throw new Error(`写入被拒绝：${filePath} 在本轮被外部改动过（mtime 不一致），不覆盖。请重新读取后再写。`)
      }

      const notes = []
      if (createdDir !== null) notes.push(`已新建目录 \`${createdDir}\``)
      if (relocated.moved.length > 0) notes.push(`搬了 ${relocated.moved.length} 张图到 ${ASSETS_DIR}/`)
      if (relocated.missing.length > 0) notes.push(`有 ${relocated.missing.length} 张图找不到，原路径保留`)
      if (relocated.failed.length > 0) notes.push(`有 ${relocated.failed.length} 张图搬运失败，原路径保留`)
      // 软限：只提示不拦（此前 README 承诺了、代码没实现）。拦的只有硬限那道墙。
      const softLimit = Number(cfg.softLimit ?? 1000)
      const finalWordsNow = countChars(card.body)
      if (finalWordsNow > softLimit) {
        notes.push(`正文 ${finalWordsNow} 字，超过软限 ${softLimit}——偏长了，建议精简`)
      }

      const suffix = notes.length === 0 ? '' : `\n（${notes.join('；')}）`
      const finalWords = countChars(card.body)
      return {
        title,
        path: filePath,
        words: finalWords,
        action: `${action}${suffix}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: [
      '检索/查询记忆卡（search）：在本地记忆库里按关键词找，返回标题 + 路径 + 摘要。要用全文请用 memory_read。',
      '',
      'query 支持 `|` 分多关键词（AND，全部命中才算），`*` 作单个词的通配，只传 `*` 返回全部。',
      '命中的位置越靠前分越高：标题 > 关键词 > 标签 > 正文 > 关系边。',
      '`tags` 是过滤（必须含）；`threshold` 挡掉低分边角料；`start_time`/`end_time` 按事情发生时间过滤',
      '（如「上个月记的那条」）。结果受总字符预算约束，预算不够的条目会降级成标题 + 短摘要。',
      '记不准标题时先用这个模糊找，再用 memory_read 精确取。',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: '检索词，`|` 分多关键词，`*` 通配' },
      limit: { type: 'number', description: '返回条数，默认 10，无上限' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤：必须包含全部给定标签' },
      threshold: { type: 'number', description: '相关度下限，默认 0（只挡零分）' },
      start_time: { type: 'string', description: '起始时间 YYYY-MM-DD（按 occurred_at，缺省回落 created）' },
      end_time: { type: 'string', description: '结束时间 YYYY-MM-DD' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          degraded: { type: 'integer', required: true },
          results: { type: 'array', required: true, items: summaryItemSchema },
        },
      },
      render: (_args, value) => {
        const results = Array.isArray(value.results) ? value.results : []
        const degraded = Number(value.degraded ?? 0)
        if (results.length === 0) {
          return text('没找到匹配的记忆卡（可以换个关键词，或用 memory_save 新建一张）。')
        }
        const lines = [`命中 ${value.total ?? results.length} 张，返回 ${results.length} 张：`]
        for (const item of results) {
          lines.push('')
          lines.push(`· ${item.title}${item.hasImage ? ' 📎' : ''}  [${item.kind}]  ${item.updated}`)
          lines.push(`  ${item.path}`)
          // 带上标签：想按 tags 过滤时不必先 read 一张卡才知道有哪些标签
          const itemTags = Array.isArray(item.tags) ? item.tags : []
          if (itemTags.length > 0) lines.push(`  #${itemTags.join(' #')}`)
          lines.push(`  ${item.summary}`)
        }
        if (degraded > 0) lines.push('', `（${degraded} 条因预算不足降级为短摘要）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const root = libraryRoot(cfg)
      const { kinds } = ensureDirs(cfg)
      const { cards } = scanLibrary(cfg, root, kinds)
      const parsed = parseQuery(args.query)
      const limit = Math.max(1, Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10)
      const threshold = Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : 0
      const wantTags = unique(args.tags ?? []).map(t => t.toLowerCase())

      const scored = []
      for (const card of cards) {
        if (!card || card.status === 'deleted') continue
        if (wantTags.length > 0) {
          const have = card.tags.map(t => t.toLowerCase())
          if (!wantTags.every(t => have.includes(t))) continue
        }
        if (!withinTime(card, args.start_time, args.end_time)) continue
        const result = scoreCard(card, parsed)
        if (result === null) continue
        if (result.score < threshold) continue
        scored.push({ card, score: result.score })
      }
      scored.sort((a, b) => (b.score - a.score) || (b.card.importance - a.card.importance) || a.card.title.localeCompare(b.card.title))

      const top = scored.slice(0, limit)
      const budget = Number(cfg.searchBudget ?? 2000)
      let used = 0
      let degraded = 0
      const results = []
      for (const { card, score } of top) {
        const summary = summarize(card.body)
        const long = `${card.title}${card.path}${summary}`
        // 降级 = 摘要截短（前 SHORT_SUMMARY_CHARS 字），不再是「标题（详见 文件名）」：
        // 那句把标题说两遍、零信息量（2026-09-28 工具调用测试：21 条里 13 条是这种废话）。
        const chars = [...summary]
        const short = chars.length <= SHORT_SUMMARY_CHARS ? summary : `${chars.slice(0, SHORT_SUMMARY_CHARS).join('')}…`
        const pick = used + countChars(long) <= budget ? summary : short
        if (pick !== summary) degraded += 1
        used += countChars(card.title) + countChars(card.path) + countChars(pick)
        results.push({
          title: card.title,
          path: card.path,
          kind: card.dir,
          updated: card.updated || card.created || '',
          score: Number(score.toFixed(3)),
          summary: pick,
          hasImage: hasImage(card.body),
          tags: card.tags,
        })
      }

      return { total: scored.length, returned: results.length, degraded, results }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: [
      '读一张记忆卡的**全文**（read / 取详情）：按标题或路径定位，返回正文、status/updated 以及附件的绝对路径。',
      '只做精确取；拿不准标题请先用 memory_search 模糊找。',
      '查不到时返回「记忆不存在」，并附最多 3 个标题相近的候选（只是提示，不会替你读）。',
      '返回里附了图片的库内路径，但不会自动读图——需要看图时再自己调 read_image。',
    ].join('\n'),
    parameters: {
      title: { type: 'string', description: '卡片标题（与 path 二选一）' },
      path: { type: 'string', description: '卡片绝对路径（与 title 二选一）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
          status: { type: 'string', required: true },
          updated: { type: 'string', required: true },
          links: { type: 'array', required: true, items: { type: 'string' } },
          attachments: { type: 'array', required: true, items: { type: 'string' } },
          body: { type: 'string', required: true },
          suggestions: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value.found) {
          const suggestions = Array.isArray(value.suggestions) ? value.suggestions : []
          const hint = suggestions.length > 0
            ? `\n你可能要找：${suggestions.map(s => `「${s}」`).join('、')}`
            : ''
          return text(`记忆不存在「${value.title || value.path || ''}」（要模糊找请用 memory_search）。${hint}`)
        }
        const links = Array.isArray(value.links) ? value.links : []
        const attachments = Array.isArray(value.attachments) ? value.attachments : []
        const lines = [
          `<card path="${value.path}">`,
          `title: ${value.title}`,
          `status: ${value.status}`,
          `updated: ${value.updated}`,
        ]
        if (links.length > 0) lines.push(`links: ${links.join(' | ')}`)
        if (attachments.length > 0) lines.push(`attachments: ${attachments.join(' | ')}`)
        lines.push('', value.body ?? '', '</card>')
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const root = libraryRoot(cfg)
      ensureDirs(cfg)
      const wanted = String(args.path ?? args.title ?? '').trim()
      if (wanted.length === 0) throw new Error('必须给 title 或 path 之一')
      const card = findCard(cfg, root, wanted, { allowOutsideRead: true })
      if (card === null) {
        // 找不到时给相近标题：原先只回一句「不存在」，库里明明有「X 与三个路径约定」，
        // 却要再调一次 search 才找得到（2026-09-28 工具调用测试）。只提示，不替人读。
        const { cards } = scanLibrary(cfg, root)
        const suggestions = cards
          .filter(c => c && c.status !== 'deleted')
          .map(c => ({ title: c.title, score: bigramOverlap(wanted, c.title) }))
          .filter(x => x.score >= 0.3)
          .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
          .slice(0, 3)
          .map(x => x.title)
        return {
          found: false, title: String(args.title ?? ''), path: String(args.path ?? ''),
          status: '', updated: '', links: [], attachments: [], body: '', suggestions,
        }
      }
      // 附件路径口径必须和 relocateImages 的改写口径一致：库内的 `_assets/...`
      // 是**相对库根**的（正文本就这么写），而其他引用按卡片目录解析。
      const cardDir = path.dirname(card.path)
      const attachments = []
      for (const m of maskCode(card.body).matchAll(/!\[[^\]]*\]\(([^)]+)\)|!\[\[([^\]]+)\]\]/g)) {
        const raw = (m[1] ?? m[2] ?? '').split('|')[0].trim()
        if (raw.length === 0 || /^(https?|data|mailto):/i.test(raw)) continue
        const resolved = raw.startsWith(`${ASSETS_DIR}/`) || raw.startsWith(`${ASSETS_DIR}\\`)
          ? path.resolve(root, raw)
          : path.resolve(cardDir, raw)
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) attachments.push(resolved)
      }
      // suggestions 在成功路径也必须是数组：output.schema 把它声明成 required，
      // 缺了会被工具框架判成 "missing required property value.suggestions"
      // （2026-09-28 梦新连续两次命中）。命中的卡片没有候选可提示，给空数组。
      return {
        found: true,
        title: card.title,
        path: card.path,
        status: card.status || 'approved',
        updated: card.updated || card.created || '',
        links: card.links.map(l => `${l.target}${l.type && l.type !== 'related' ? ` (${l.type})` : ''}`),
        attachments: unique(attachments),
        body: card.body,
        suggestions: [],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_update',
    description: [
      '修改/更新一张已存在的记忆卡（update）：正文、标签、状态、重要度、关键词。给哪个改哪个，`created` 不动、`updated` 自动刷新。',
      '`mode` 决定正文怎么改，缺省 `replace`：',
      '  `replace` 整段替换正文（传 `content`）',
      '  `append` 续写到 `section` 小节末尾，节不存在则新建；不传 section 用 `更新 YYYY-MM-DD`',
      '  `section` 整节替换（`section` 必填），节不存在则新建——只改一节，不用重抄全文',
      '  `str` 精确替换一处（`find` + `content`）；`find` 必须在正文里唯一出现，不唯一就报错不动手',
      '  `rename` 改标题（`newTitle`）：改文件名、新旧标题都记进 aliases、并改掉引用者的 `[[旧标题]]`',
      '其余参数（tags / keywords / importance / status / occurred_at）任意 mode 都能一起给。',
      '`status` 只用 approved / deleted；软删请走 memory_forget（会同时移进回收站）。',
      '`occurred_at` 可以补记「这件事实际发生在哪天」（YYYY-MM-DD），时间检索按它过滤。',
      '写入前会比对该卡「本次读取到写入之间」的 mtime：期间被外部改过（Obsidian 手改、别的工具写）就拒绝并回报，不覆盖。',
      '注意边界：它只护住这一次调用，不追踪更早的外部改动——你先读到旧内容、隔几轮再来改，它不会拦。',
    ].join('\n'),
    parameters: {
      title: { type: 'string', required: true, description: '要改的卡片标题（或绝对路径）' },
      mode: { type: 'string', description: 'replace（缺省）/ append / section / str / rename' },
      content: { type: 'string', description: 'replace=新正文；append=追加段；section=该节内容；str=替换成什么' },
      section: { type: 'string', description: 'mode=append / section：小节标题（如 `更新 2026-10-01`；append 不传则用当天）' },
      find: { type: 'string', description: 'mode=str：要被替换掉的原文，必须在正文里唯一出现' },
      newTitle: { type: 'string', description: 'mode=rename：新标题' },
      tags: { type: 'array', items: { type: 'string' }, description: '新标签列表，整段替换' },
      status: { type: 'string', description: 'approved / deleted' },
      importance: { type: 'number', description: '重要度 1-5' },
      keywords: { type: 'string', description: '新关键词，逗号分隔，整段替换' },
      occurred_at: { type: 'string', description: '事情实际发生时间 YYYY-MM-DD（补记用；save 时也可直接给）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
          words: { type: 'integer', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          renamedFrom: { type: 'string', description: 'mode=rename：改动前的标题' },
          referrers: { type: 'integer', description: 'mode=rename：已改掉引用的卡片数' },
          referrerFailures: { type: 'array', items: { type: 'string' }, description: 'mode=rename：引用没改成的卡片标题' },
        },
      },
      render: (_args, value) => {
        const changed = Array.isArray(value.changed) ? value.changed : []
        const head = value.renamedFrom
          ? `【记忆已改名】${value.renamedFrom} → ${value.title}`
          : `【记忆已更新】${value.title}`
        return text(
          `${head}\n路径：${value.path}\n改了：${changed.join('、') || '（无）'}\n正文 ${value.words ?? 0} 字\n`
          + 'Write saved — do not repeat.',
        )
      },
    },
    async execute(args) {
      const root = libraryRoot(cfg)
      ensureDirs(cfg)
      const wanted = String(args.title ?? '').trim()
      if (wanted.length === 0) throw new Error('title 不能为空')
      const mode = String(args.mode ?? 'replace').trim().toLowerCase() || 'replace'
      if (!EDIT_MODES.includes(mode)) throw new Error(`mode 只能是 ${EDIT_MODES.join(' / ')}`)
      const card = findCard(cfg, root, wanted)
      if (card === null) throw new Error(`记忆不存在「${wanted}」（要模糊找请用 memory_search）`)

      if (cfg.sensitiveScan !== false) {
        const hit = scanSensitiveFields({ tags: args.tags, keywords: args.keywords })
        if (hit !== null) throw new Error(`拒绝写入：${hit.field}命中敏感信息（${hit.label}）。请改用脱敏版本重试。`)
      }

      // 改名走独立路径：它动的是文件位置 + 全库引用者，跟「改字段」不是一回事
      if (mode === 'rename') return renameCard(cfg, root, card, args)

      const hasContent = typeof args.content === 'string'
      if (mode === 'str') {
        if (String(args.find ?? '').length === 0) throw new Error('mode=str 需要 find（要被替换掉的原文）')
        if (!hasContent) throw new Error('mode=str 需要 content（替换成什么）')
      } else if (mode !== 'replace' && !hasContent) {
        throw new Error(`mode=${mode} 需要 content`)
      }
      if (args.section !== undefined && String(args.section).trim().length === 0) {
        throw new Error('section 不能是空字符串（append 想用默认标题就别传这个参数）')
      }
      if (mode === 'section' && (args.section === undefined || String(args.section).trim().length === 0)) {
        throw new Error('mode=section 需要 section（小节标题）')
      }

      const changed = []
      const next = { ...card, links: [...card.links] }
      let body = null
      if (mode === 'replace') {
        if (hasContent) body = args.content
      } else if (mode === 'append') {
        const heading = args.section === undefined ? `更新 ${localDate()}` : String(args.section).trim()
        body = writeSection(card.body, heading, args.content, 'append')
        changed.push(`节「${heading}」`)
      } else if (mode === 'section') {
        const heading = String(args.section).trim()
        body = writeSection(card.body, heading, args.content, 'replace')
        changed.push(`节「${heading}」`)
      } else {
        const find = String(args.find)
        const hits = String(card.body ?? '').split(find).length - 1
        if (hits === 0) throw new Error(`正文里找不到「${find}」，没动任何东西`)
        if (hits > 1) throw new Error(`「${find}」在正文里出现 ${hits} 次，不唯一——多带点上下文再替换，避免改错地方`)
        body = String(card.body ?? '').replace(find, args.content)
        changed.push('正文片段')
      }

      if (body !== null) {
        const hardLimit = Number(cfg.hardLimit ?? 4000)
        const words = countChars(body)
        if (words > hardLimit) {
          throw new Error(`正文 ${words} 字，超过硬限 ${hardLimit} 字。别砍信息——写文件，或改用「卡 + 指针」。`)
        }
        if (cfg.sensitiveScan !== false) {
          const hit = scanSensitive(body)
          if (hit !== null) throw new Error(`拒绝写入：正文命中敏感信息（${hit}）。请改用脱敏版本重试。`)
        }
        const relocated = relocateImages(cfg, slugify(card.title, 'card'), body, root)
        next.body = relocated.body
        if (relocated.moved.length > 0) changed.push(`图 ${relocated.moved.length} 张已搬入库内`)
        if (mode === 'replace') changed.push('正文')
      }
      if (Array.isArray(args.tags)) {
        next.tags = unique(args.tags)
        changed.push('tags')
      }
      if (typeof args.keywords === 'string') {
        next.keywords = unique(splitKeywords(args.keywords))
        changed.push('keywords')
      }
      if (typeof args.occurred_at === 'string' && args.occurred_at.trim().length > 0) {
        // 补记「实际发生时间」——时间检索按它过滤，save 之后原先没有第二条通道能改它
        next.occurred_at = args.occurred_at.trim()
        changed.push('occurred_at')
      }
      if (args.importance !== undefined && Number.isFinite(Number(args.importance))) {
        next.importance = Number(args.importance)
        changed.push('importance')
      }
      if (typeof args.status === 'string') {
        const status = args.status.trim()
        if (!STATUSES.includes(status)) throw new Error(`status 只能是 ${STATUSES.join(' / ')}`)
        next.status = status
        changed.push('status')
      }
      if (changed.length === 0) throw new Error('没有给任何要改的字段')

      next.updated = localDate()
      const stat = fs.statSync(card.path)
      const written = atomicWrite(cfg, card.path, serializeCard(next), stat.mtimeMs)
      if (!written.ok) {
        throw new Error(`写入被拒绝：${card.path} 在本次调用期间被外部改动过（mtime 不一致），不覆盖。请重新读取后再改。`)
      }
      return { title: next.title, path: card.path, words: countChars(next.body), changed }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_link',
    description: [
      '在两张记忆卡之间建立一条关系边：两边的正文各追加一条 `[[对方]]`，各自的 frontmatter 记下 links。',
      '原子操作：**两边都找得到才写**，否则整条不写——绝不留下「A 知道 B、B 不知道 A」的单向边。',
      `type 取值：${LINK_TYPES.join(' / ')}，默认 related；weight 0-1 默认 0.7。`,
      '同类型同目标的边只留一条：再次调用会跳过；换 `type` 则是把这对卡之间的关系改成新的，不会堆出第二条。',
    ].join('\n'),
    parameters: {
      source: { type: 'string', required: true, description: '源卡标题（或绝对路径）' },
      target: { type: 'string', required: true, description: '目标卡标题（或绝对路径）' },
      type: { type: 'string', description: `关系类型：${LINK_TYPES.join('/')}，默认 related` },
      weight: { type: 'number', description: '关系权重 0-1，默认 0.7' },
      description: { type: 'string', description: '这条关系的说明' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          target: { type: 'string', required: true },
          type: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        if (value.status === 'created') {
          return text(`【已连边】${value.source} --${value.type}--> ${value.target}\n（两张卡的正文与 frontmatter 都已更新，Obsidian 图谱里能看到这条线）`)
        }
        if (value.status === 'updated') {
          return text(`【已更新边】${value.source} --${value.type}--> ${value.target}\n（同一对卡之间的这条关系改为新的类型/权重/说明，两边同步）`)
        }
        return text(`【跳过】${value.source} --${value.type}--> ${value.target}：${value.status ?? '未知'}`)
      },
    },
    async execute(args) {
      const root = libraryRoot(cfg)
      ensureDirs(cfg)
      const source = findCard(cfg, root, String(args.source ?? '').trim())
      const target = findCard(cfg, root, String(args.target ?? '').trim())
      if (source === null || target === null) {
        const missing = []
        if (source === null) missing.push(`源卡「${args.source}」`)
        if (target === null) missing.push(`目标卡「${args.target}」`)
        throw new Error(`${missing.join('、')}不存在，整条关系未写入（不许单向边）。要模糊找请用 memory_search。`)
      }
      if (source.path === target.path) throw new Error('source 与 target 是同一张卡，不能连边')

      // 单行化：描述里的真换行会把 frontmatter 写成两行（回读多出假边），
      // 同时正文那条 callout 也得用同一份值，不然两边不一致。
      const type = LINK_TYPES.includes(flattenLine(args.type)) ? flattenLine(args.type) : 'related'
      const weight = Number.isFinite(Number(args.weight)) ? Number(args.weight) : 0.7
      const description = flattenLine(args.description)
      if (cfg.sensitiveScan !== false) {
        const hit = scanSensitiveFields({ 关系说明: description })
        if (hit !== null) throw new Error(`拒绝写入：${hit.field}命中敏感信息（${hit.label}）。请改用脱敏版本重试。`)
      }

      // 未显式提供的字段 =「没说」，不该覆盖已有边的值；只有明确给了才覆盖。
      const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
      const edgeOf = (card, otherTitle) => card.links.find(l => l.target === otherTitle)
      const srcOld = edgeOf(source, target.title)
      const tgtOld = edgeOf(target, source.title)

      // 「边已存在」看目标 + 类型；只有**显式**给了不同的 weight/description 才算要改。
      // 缺省或空的 weight/description 都是「没说」，不是「要改」——不然一次普通调用
      // 会把已有边的 0.8 冲成 0.7、把说明清空（模型常把可选参数传成 undefined）。
      const wantsWeight = hasOwn(args, 'weight') && Number.isFinite(Number(args.weight))
      const wantsDesc = hasOwn(args, 'description') && String(args.description).trim().length > 0
      // 换类型时，旧边的 weight/description 属于**旧关系**，不能默认继承过来；
      // 没显式给就落回新关系的默认值（0.7 / 空）。想保留就显式写一遍。
      const keepEdgeFields = (old) => old !== undefined && old.type === type
      const merged = (old) => ({
        type,
        weight: wantsWeight ? weight : (keepEdgeFields(old) ? Number(old.weight ?? 0.7) : 0.7),
        description: wantsDesc ? description : (keepEdgeFields(old) ? String(old.description ?? '') : ''),
      })
      const differing = (old) => {
        if (old === undefined || old.type !== type) return true
        const next = merged(old)
        return Number(old.weight) !== next.weight || String(old.description ?? '') !== next.description
      }
      const srcDiff = differing(srcOld)
      const tgtDiff = differing(tgtOld)
      if (srcOld !== undefined && tgtOld !== undefined && !srcDiff && !tgtDiff) {
        return { source: source.title, target: target.title, type, status: 'already-linked' }
      }
      const updating = srcOld !== undefined && tgtOld !== undefined

      const stamp = localDate()
      const mergedEdge = (old, otherTitle) => ({ target: otherTitle, ...merged(old) })
      const mergeLinks = (card, otherTitle, old) => {
        const idx = card.links.findIndex(l => l.target === otherTitle)
        const entry = mergedEdge(old, otherTitle)
        if (idx === -1) return [...card.links, entry]
        return card.links.map((l, i) => (i === idx ? entry : l))
      }
      // 正文 callout 同步改写：旧关系线换成新的 type/说明（不重复追加一行）。
      // 正文别处已经引用了对方但没写过 callout 时保持原样，避免动词重复。
      const makeBody = (card, other) => {
        const wiki = `[[${other.title}]]`
        const note = description.length > 0 ? `（${description}）` : ''
        const fresh = `> ${type}: ${wiki}${note}`
        if (card.body.includes(fresh)) return card.body
        const line = new RegExp(`^>[^\\n]*${wiki.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*$`, 'm')
        if (line.test(card.body)) return card.body.replace(line, fresh)
        if (card.body.includes(wiki)) return card.body
        return `${card.body}\n\n${fresh}`
      }
      const nextSource = {
        ...source,
        links: mergeLinks(source, target.title, srcOld),
        body: makeBody(source, target),
        updated: stamp,
      }
      const nextTarget = {
        ...target,
        links: mergeLinks(target, source.title, tgtOld),
        body: makeBody(target, source),
        updated: stamp,
      }

      const sourceMtime = fs.statSync(source.path).mtimeMs
      const targetMtime = fs.statSync(target.path).mtimeMs
      const first = atomicWrite(cfg, source.path, serializeCard(nextSource), sourceMtime)
      if (!first.ok) {
        throw new Error(`写入被拒绝：${source.path} 被外部改动过（mtime 不一致），两边都没改。`)
      }
      // 第一边的磁盘状态留作回滚基线：只回滚**自己刚写的那一版**，
      // 期间的外部改动会因为基线不匹配而被拒（不然回滚本身就是一次静默覆盖）。
      const writtenSourceMtime = fs.statSync(source.path).mtimeMs
      const second = atomicWrite(cfg, target.path, serializeCard(nextTarget), targetMtime)
      if (!second.ok) {
        let rolledBack = false
        try {
          rolledBack = atomicWrite(cfg, source.path, serializeCard(source), writtenSourceMtime).ok
        } catch {
          rolledBack = false
        }
        // 回滚结果如实上报：回滚失败时绝不能宣称「已回滚、两边都没改」——
        // 那句话会让用户以为盘上是干净的，而单向边正躺在那儿。
        throw new Error(
          rolledBack
            ? `写入被拒绝：${target.path} 被外部改动过（mtime 不一致）。已回滚源卡，两边都没改。`
            : `写入被拒绝：${target.path} 被外部改动过（mtime 不一致），且源卡回滚也未成功——`
              + `注意：源卡 ${source.path} 可能已留有指向「${target.title}」的单向边，请人工核对。`,
        )
      }
      return { source: source.title, target: target.title, type, status: updating ? 'updated' : 'created' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: [
      '删除一张记忆卡（forget / delete）：默认**软删** —— 标 `status: deleted` 并移进库内 `_trashed/`。',
      '**两步走**：第一次调用（不传 `confirm`）只返回预览——要删的是哪张卡、有哪些卡引用了它；确认无误后带 `confirm: true` 再调一次才真删。',
      '`permanent: true` 才会真删文件；恢复 = 在 Obsidian 里把文件从 `_trashed/` 拖回原目录（或改回 `approved`）。',
    ].join('\n'),
    parameters: {
      title: { type: 'string', required: true, description: '卡片标题（或绝对路径）' },
      confirm: { type: 'boolean', description: '**必须显式传 true 才会真删**；缺省时只返回预览（要删什么、谁会受影响）。这是防误删的硬闸，删卡必须走两步。' },
      permanent: { type: 'boolean', description: 'true = 永久删除（默认 false 软删进 `_trashed/`），同样需要 confirm: true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          links: { type: 'integer', required: true },
          referrers: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        if (value.mode === 'preview') {
          return text([
            `【待确认】即将删除「${value.title}」，**什么都没动**。`,
            `目标：${value.path}`,
            `它引用了 ${value.links} 条关系；有 ${value.referrers} 张卡引用了它。`,
            '确认无误请再调一次并带上 `confirm: true`；不确认就到此为止。',
          ].join('\n'))
        }
        if (value.mode === 'deleted') {
          return text(`【已永久删除】${value.title}\n原路径：${value.path}\n`)
        }
        if (value.mode === 'not-found') {
          return text(`记忆不存在「${value.title}」，没动任何东西。`)
        }
        return text(`【已忘掉】${value.title}\n已移进回收站：${value.path}\n（恢复 = 在 Obsidian 里拖回原目录）`)
      },
    },
    async execute(args) {
      const root = libraryRoot(cfg)
      ensureDirs(cfg)
      const wanted = String(args.title ?? '').trim()
      if (wanted.length === 0) throw new Error('title 不能为空')
      // 永久删除允许摸回收站（清回收站是正当需求）；软删不允许——已在回收站的卡再软删没有意义。
      const card = findCard(cfg, root, wanted, { includeTrashed: args.permanent === true })
      // 硬守卫：软删要把文件搬进 _trashed、永久删除直接 rmSync——
      // 检索层放宽过（memory_read 允许读库外），但删除绝不能跟着放宽。
      if (card === null || !isInsideLibrary(card.path, root)) {
        return { title: wanted, path: '', mode: 'not-found', links: 0, referrers: 0 }
      }

      // 硬闸：没显式 confirm 就只预览，绝不落手。
      // 理由：提示词约束不住执行者（会读、会引用、仍会照删），只有参数级的闸门绕不过去。
      if (args.confirm !== true) {
        let referrers = 0
        const { cards } = scanLibrary(cfg, root, new Set(KINDS.map(([d]) => d)))
        for (const other of cards) {
          if (!other || other.path === card.path) continue
          if (other.links.some(l => linkPointsTo(l.target, card))) referrers += 1
        }
        return {
          title: card.title,
          path: card.path,
          mode: 'preview',
          links: card.links.length,
          referrers,
        }
      }

      if (args.permanent === true) {
        fs.rmSync(card.path, { force: true })
        return { title: card.title, path: card.path, mode: 'deleted', links: 0, referrers: 0 }
      }

      const trash = trashRoot(cfg)
      fs.mkdirSync(trash, { recursive: true })
      let dest = path.join(trash, path.basename(card.path))
      if (fs.existsSync(dest)) {
        dest = path.join(trash, `${path.basename(card.path, '.md')}-${Date.now()}.md`)
      }
      const next = { ...card, status: 'deleted', updated: localDate() }
      const stat = fs.statSync(card.path)
      const written = atomicWrite(cfg, card.path, serializeCard(next), stat.mtimeMs)
      if (!written.ok) throw new Error(`写入被拒绝：${card.path} 被外部改动过（mtime 不一致）。`)
      fs.renameSync(card.path, dest)
      return { title: card.title, path: dest, mode: 'trashed', links: 0, referrers: 0 }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: [
      '只读体检（status / 健康检查）：总卡数 / 各 kind 分布 / 超长卡 / 死链 / 库外链接 / 回收站条目 / 库大小。',
      '死链 = 卡里 `[[目标]]` 指向**记忆库内**的卡却找不到（纯标题写错，或写的是库内目录前缀但卡不在）。',
      '指向记忆库之外（如知识库的 `[[技术/xxx]]`）的链接单独计成「库外链接」——本工具不解析它，只保证不误报成死链；要验它看 Obsidian 的「未解析链接」。',
      '不改任何东西，随时可跑。',
    ].join('\n'),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          trashed: { type: 'integer', required: true },
          oversized: { type: 'array', required: true, items: { type: 'string' } },
          deadLinks: { type: 'array', required: true, items: { type: 'string' } },
          externalLinks: { type: 'integer', required: true },
          duplicates: { type: 'array', required: true, items: { type: 'string' } },
          kinds: { type: 'array', required: true, items: kindStatSchema },
        },
      },
      render: (_args, value) => {
        const kinds = Array.isArray(value.kinds) ? value.kinds : []
        const oversized = Array.isArray(value.oversized) ? value.oversized : []
        const deadLinks = Array.isArray(value.deadLinks) ? value.deadLinks : []
        const lines = [`记忆库体检：${value.total ?? 0} 张卡，回收站 ${value.trashed ?? 0} 张`]
        lines.push('', '各目录分布：')
        for (const item of kinds) lines.push(`  ${item.dir}: ${item.count} 张`)
        lines.push('', `超长卡（> 硬限）：${oversized.length === 0 ? '无' : ''}`)
        for (const item of oversized) lines.push(`  ${item}`)
        lines.push('', `死链：${deadLinks.length === 0 ? '无' : ''}`)
        for (const item of deadLinks) lines.push(`  ${item}`)
        const externalLinks = Number(value.externalLinks ?? 0)
        if (externalLinks > 0) {
          lines.push('', `库外链接：${externalLinks} 条（指向记忆库之外的文档，本工具不解析；在 Obsidian 里能打开就不算断链）`)
        }
        const duplicates = Array.isArray(value.duplicates) ? value.duplicates : []
        if (duplicates.length > 0) {
          lines.push('', `重名卡：${duplicates.length} 组（同一标题多张卡，read/update 只会命中其中一张，建议合并或改标题）`)
          for (const item of duplicates) lines.push(`  ${item}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute() {
      const root = libraryRoot(cfg)
      const { kinds } = ensureDirs(cfg)
      if (!fs.existsSync(root)) {
        return { total: 0, trashed: 0, oversized: [], deadLinks: [], externalLinks: 0, duplicates: [], kinds: [] }
      }
      const { cards, trashed } = scanLibrary(cfg, root, kinds)
      const alive = cards.filter(Boolean)
      // 解析目标同时认「标题」与「文件名」：Obsidian 的 wikilink 按文件名（basename）解析，
      // 而我们的文件名是 slug 后的形式，常与标题不同（空格→连字符…）。
      // 只装标题，会让 `[[08-Mistakes/按文件名写的卡]]` 这种链接被误报成死链（2026-09-28 真实库实测）。
      const titles = new Set()
      for (const card of alive) {
        titles.add(card.title)
        if (card.path) titles.add(path.basename(card.path, '.md'))
      }
      const hardLimit = Number(cfg.hardLimit ?? 4000)

      const oversized = []
      const deadLinks = []
      let externalLinks = 0
      for (const card of alive) {
        const words = countChars(card.body)
        if (words > hardLimit) oversized.push(`${card.title}（${words} 字）`)
        for (const link of card.links) {
          const raw = String(link.target)
          const target = path.basename(raw, '.md')
          if (titles.has(raw) || titles.has(target)) continue
          // 带路径且首段不是库内目录 → 指向库外文档（知识库其余部分）：
          // 本工具不解析它，也**不许**报成死链（2026-09-28 实测：库外链接被误报成死链）。
          const slash = raw.indexOf('/')
          const head = slash > 0 ? raw.slice(0, slash) : ''
          if (head.length > 0 && !kinds.has(head)) {
            externalLinks += 1
            continue
          }
          deadLinks.push(`${card.title} → [[${link.target}]]`)
        }
      }

      // 重名：同一标题（忽略大小写）多张未删卡。findCard 只取第一张，其余的 read/update 永远够不着
      // （2026-09-28 边界探测：Obsidian 里手建的同名卡）。库根相对路径列出，方便人工合并。
      const byTitle = new Map()
      for (const card of alive) {
        if (card.status === 'deleted') continue
        const key = card.title.toLowerCase()
        if (!byTitle.has(key)) byTitle.set(key, [])
        byTitle.get(key).push(card)
      }
      const duplicates = [...byTitle.values()]
        .filter(group => group.length > 1)
        .map(group => `${group[0].title}：${group.map(c => path.relative(root, c.path).replace(/\\/g, '/')).sort().join(' | ')}`)
        .sort()

      const byKind = new Map()
      for (const card of alive) {
        const key = card.dir || 'unknown'
        byKind.set(key, (byKind.get(key) ?? 0) + 1)
      }
      const kindStats = [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, n]) => ({
        dir,
        count: n,
      }))

      return {
        total: alive.length,
        trashed: trashed.filter(Boolean).length,
        oversized,
        deadLinks: unique(deadLinks),
        externalLinks,
        duplicates,
        kinds: kindStats,
      }
    },
  }))
}

/** 供自测直接调用内部纯函数。 */
export const __internals = {
  parseCard,
  serializeCard,
  slugify,
  matchKind,
  bigramOverlap,
  parseQuery,
  scoreCard,
  summarize,
  scanSensitive,
  findImageRefs,
  isLocalImagePath,
  resolveImagePath,
  parseInlineObject,
  splitTokens,
  stripCode,
  asStringList,
  flattenLine,
  truncateByBytes,
  uniqueCardPath,
  yamlScalar,
  parseScalar,
  localDate,
  linkPointsTo,
  splitKeywords,
  relocateImages,
  atomicWrite,
  scanLibrary,
  findCard,
  createKindDir,
  ensureDirs,
  libraryRoot,
  unwrapConfig,
  KINDS,
  DEFAULT_KIND,
}
