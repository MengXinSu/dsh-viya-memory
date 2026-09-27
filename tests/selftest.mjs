// viya-memory 自测：node --test tests/selftest.mjs
//
// 关键：不启动 DSH，但走**真实执行路径** —— mock 一个 ctx 调 apply()，捕获实际
// 注册的 tool definition（含 defineTool 的编译与 output 校验），再真的调用 execute。
// 「能 import」不等于「能跑」，所以每个工具都要有一次真实调用。

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const mod = await import('../lib/index.js')
const { __internals: I } = mod

// ─────────────────── mock 上下文：捕获注册 ───────────────────

function makeCtx() {
  const tools = new Map()
  const sections = []
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      getSectionOrder: () => 10300,
      section(options) {
        sections.push(options)
        return () => {}
      },
    },
  }
  return { ctx, tools, sections }
}

function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viya-memory-test-'))
  return { dir, config: { library: dir, softLimit: 400, hardLimit: 800, searchBudget: 2000, sensitiveScan: true } }
}

const EXPECTED_TOOLS = [
  'memory_save', 'memory_search', 'memory_read', 'memory_update',
  'memory_link', 'memory_forget', 'memory_stats',
]

// ─────────────────── 1. 模块与注册 ───────────────────

describe('模块与工具注册', () => {
  it('导出 apply/name/inject/Config', () => {
    assert.equal(typeof mod.apply, 'function')
    assert.equal(mod.name, 'viya-memory')
    assert.deepEqual(mod.inject, ['tools', 'systemPrompt'])
    assert.equal(typeof mod.Config, 'function', 'Config 应该是 schemastery schema')
  })

  // 2026-09-27 血案：apply() 里碰了 ctx.systemPrompt，inject 却只写了 ['tools']，
  // 结果 cordis 在 Fiber.execute 抛
  //   cannot get property "systemPrompt" without inject
  // ——插件整条不激活（GUI 显示「启用失败」），而当时 61/61 全绿：因为 mock ctx
  // 是个普通对象，谁访问它都不拦。所以这条检查必须直接静态扫源码，绕开 mock。
  it('inject 覆盖 apply 实际访问的每一个 cordis 服务', () => {
    const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const code = source
      .replace(/^\s*\/\/.*$/gm, '')      // 去行注释：注释里提到 ctx.xxx 不该误报
      .replace(/\/\*[\s\S]*?\*\//g, '')  // 去块注释
    const accessed = new Set([...code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]))
    // cordis Context 的基础成员不需要 inject；服务访问（tools/systemPrompt/...）才需要。
    const BUILTINS = new Set([
      'on', 'off', 'once', 'emit', 'waterfall', 'parallel', 'bail', 'effect',
      'inject', 'get', 'provide', 'set', 'plugin', 'scope', 'isolate', 'extend',
      'logger', 'root', 'fiber', 'registry', 'reflect', 'dispose',
    ])
    const missing = [...accessed].filter(n => !BUILTINS.has(n) && !mod.inject.includes(n))
    assert.deepEqual(missing, [],
      `apply 访问了未声明 inject 的服务，真实运行时会抛 "cannot get property ... without inject"：${missing.join(', ')}`)
  })

  // 2026-09-27 第二起血案：library 写成 z.string().default(...).volatile()，schemastery
  // 对 volatile 字段会 createVolatile(value) 把值包成盒子对象 → config.library 的
  // typeof 是 object、String() 得到 "[object Object]"，所有卡片被写进 cwd 下的
  // "[object Object]\" 目录。mock ctx 传进去的永远是我手写的普通字符串，抓不到；
  // 所以这条必须直接拿真 schema 解析一次真路径，任何包装都瞒不过去。
  it('Config 解析后 library 仍是字符串（volatile 会把它包成对象）', () => {
    const parsed = mod.Config({ library: 'C:\\test-vault' })
    assert.equal(typeof parsed.library, 'string', 'library 被包装成对象了——检查是否误用了 .volatile()')
    assert.equal(parsed.library, 'C:\\test-vault')
    const byDefault = mod.Config({})
    assert.equal(typeof byDefault.library, 'string', '默认值被包装了')
    // 默认必须是空串：强制使用者显式配置 vault 路径，避免卡片被静默写进某个意外目录。
    assert.equal(byDefault.library, '', 'library 默认值必须是空串（必填项）')
  })

  // 2026-09-27 第三起：**其余**字段的 .volatile() 是故意的（让设置服务投影成表单），
  // 但它们解析后是 `{ get() }` 盒子——直接当普通值读会得到 "[object Object]"，
  // `box > 800` 是 NaN 比较（永远 false）。后果是字数硬限、检索预算、user.md 路径
  // **全部静默失效**（不报错、只是不生效，最难发现的那一类）。
  // 这条用真 schema 造出真盒子，验证 unwrapConfig 把它们还原成普通值。
  it('unwrapConfig 把 volatile 盒子还原成普通值（阈值不能是 NaN 比较）', () => {
    const raw = mod.Config({ library: 'C:\\test-vault' })
    assert.equal(typeof raw.softLimit, 'object',
      'softLimit 应当是 volatile 盒子——如果它已变成普通值，说明 volatile 被去掉了，请更新本测试')
    const cfg = mod.__internals.unwrapConfig(raw)
    assert.equal(typeof cfg.library, 'string')
    assert.equal(typeof cfg.softLimit, 'number', 'softLimit 解包后必须是 number，否则字数软限失效')
    assert.equal(typeof cfg.hardLimit, 'number', 'hardLimit 解包后必须是 number，否则字数硬限失效')
    assert.equal(typeof cfg.searchBudget, 'number', 'searchBudget 解包后必须是 number，否则检索预算失效')
    assert.equal(typeof cfg.sensitiveScan, 'boolean', 'sensitiveScan 解包后必须是 boolean，否则敏感信息扫描会被绕过')
    assert.equal(typeof cfg.userFile, 'string', 'userFile 解包后必须是 string，否则 user.md 路径会变成 [object Object]')
    assert.equal(cfg.softLimit, 400)
    assert.equal(cfg.hardLimit, 800)
    // 比较语义必须成立（盒子做 > 比较永远是 false）
    assert.ok(cfg.hardLimit > cfg.softLimit, '硬限必须真的大于软限')
    assert.ok(cfg.sensitiveScan === true)
    // 普通值照样原样通过
    const plain = mod.__internals.unwrapConfig({ library: 'C:\\x', hardLimit: 800, sensitiveScan: false })
    assert.equal(plain.library, 'C:\\x')
    assert.equal(plain.hardLimit, 800)
    assert.equal(plain.sensitiveScan, false)
  })

  it('apply 注册七个工具 + 一个 user.md section', () => {
    const { ctx, tools, sections } = makeCtx()
    mod.apply(ctx, { library: 'C:\\nope' })
    assert.deepEqual([...tools.keys()].sort(), [...EXPECTED_TOOLS].sort())
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'viya-memory:user')
    assert.ok(sections[0].order > 10200, 'order 必须排在环境后缀 10200 之后')
    assert.equal(typeof sections[0].text, 'function')
    // 必须是 false：user.md 是自由文本，任何 `{{词}}` 都会让 renderPrompt 抛
    // 「unknown prompt variable」并**让整个 prompt 组装失败**（会话跑不动）。
    assert.equal(sections[0].interpolate, false, 'section 必须声明 interpolate: false')
  })

  it('每个工具都有合法 output 声明（register 会校验）', () => {
    const { ctx, tools } = makeCtx()
    mod.apply(ctx, { library: 'C:\\nope' })
    for (const [name, def] of tools) {
      assert.ok(def.description.length > 20, `${name} 缺 description`)
      assert.equal(typeof def.execute, 'function', `${name} 缺 execute`)
      assert.ok(def.output && typeof def.output.render === 'function', `${name} 缺 output.render`)
      assert.ok(def.output.schema && def.output.schema.type === 'object', `${name} output.schema 不是 object`)
      assert.equal(typeof def.output.schema.properties, 'object', `${name} output.schema 缺 properties`)
      assert.equal(def.output.schema.additionalProperties, false, `${name} output.schema 应封闭`)
    }
  })

  it('每个 render 对「字段缺失的 canonical 值」也不抛错（replay 安全）', () => {
    const { ctx, tools } = makeCtx()
    mod.apply(ctx, { library: 'C:\\nope' })
    // 空对象不是合法 canonical 值，但 render 绝不能因此抛错（历史重放可能遇到旧形状）
    for (const [name, def] of tools) {
      const rendered = def.output.render({}, {})
      assert.ok(Array.isArray(rendered) && rendered[0].type === 'text', `${name} render 没返回 text 块`)
    }
  })

  it('user.md 不存在时 section 返回空串（不破坏 prompt）', () => {
    const { ctx, sections } = makeCtx()
    mod.apply(ctx, { library: 'C:\\definitely\\missing' })
    assert.equal(sections[0].text(), '')
  })
})

// ─────────────────── 2. frontmatter 往返 ───────────────────

describe('frontmatter 解析与生成', () => {
  it('标量：需要引号的加引号，数字/布尔裸写', () => {
    assert.equal(I.yamlScalar('abc'), 'abc')
    assert.equal(I.yamlScalar('hello world'), 'hello world')
    assert.equal(I.yamlScalar('03-Knowledge'), '03-Knowledge')
    assert.equal(I.yamlScalar('123'), "'123'")
    assert.equal(I.yamlScalar('true'), "'true'")
    assert.equal(I.yamlScalar('a: b'), "'a: b'")
    assert.equal(I.yamlScalar("it's"), "'it''s'")
    assert.equal(I.yamlScalar(5), '5')
    assert.equal(I.yamlScalar(''), "''")
  })

  it('往返：serialize → parse 字段全对', () => {
    const card = {
      formatVersion: 1,
      kind: '03-Knowledge',
      title: '测试卡：带冒号与 "引号"',
      tags: ['技术', 'DSH'],
      keywords: ['mtime', '并发写冲突', 'concurrency'],
      importance: 4,
      created: '2026-09-27',
      updated: '2026-09-28',
      status: 'approved',
      severity: 'warn',
      source: 'viya',
      occurred_at: '2026-09-20',
      links: [
        { target: '另一张卡', type: 'explains', weight: 0.8, description: '说明关系' },
        { target: '第三张', type: 'related', weight: 0.7, description: '' },
      ],
      body: '这是正文。\n\n## 小节\n\n带 [[另一张卡]] 的双链。',
    }
    const back = I.parseCard(I.serializeCard(card), path.join('/lib', '03-Knowledge', 'x.md'))
    assert.equal(back.title, card.title)
    assert.deepEqual(back.tags, card.tags)
    assert.deepEqual(back.keywords, card.keywords)
    assert.equal(back.importance, 4)
    assert.equal(back.created, '2026-09-27')
    assert.equal(back.updated, '2026-09-28')
    assert.equal(back.severity, 'warn')
    assert.equal(back.occurred_at, '2026-09-20')
    assert.equal(back.body.trim(), card.body.trim())
    assert.equal(back.links.find(l => l.target === '另一张卡').type, 'explains')
    assert.equal(back.links.find(l => l.target === '另一张卡').weight, 0.8)
  })

  // 2026-09-28：正文里写代码示例（反引号/围栏块）时，里面的 `[[...]]` 被当成真链接，
  // 于是 links 里多出一条假边（target 变成一段文字）——在教训卡上实测到。
  it('反引号与代码块里的 [[...]] 不算关系边', () => {
    const body = [
      '行内示例：`[[假目标]]` 应该被忽略。',
      '',
      '```js',
      '// 代码块里的 [[另一个假目标]] 也是示例',
      'const x = 1',
      '```',
      '',
      '而 [[真目标]] 才算。',
    ].join('\n')
    const card = I.parseCard(`---\ntitle: t\ntags: []\nkeywords: []\n---\n\n${body}`, '/x/03-Knowledge/t.md')
    assert.deepEqual(card.links.map(l => l.target), ['真目标'], '只该留下代码外的真链接')
    assert.equal(I.stripCode('`[[a]]`'), ' ')
    assert.equal(I.stripCode('前 `[[a]]` 后').includes('[['), false)
  })

  it('正文里的 [[双链]] 会被算成关系边（related）', () => {
    const body = '见 [[旧卡的标题]] 和 [[另一张|显示名]]。'
    const card = I.parseCard(`---\ntitle: t\ntags: []\nkeywords: []\n---\n\n${body}`, '/x/03-Knowledge/t.md')
    const targets = card.links.map(l => l.target).sort()
    assert.deepEqual(targets, ['另一张', '旧卡的标题'])
    assert.ok(card.links.every(l => l.type === 'related'))
  })

  it('无 frontmatter 的文件也能解析（手写卡不炸）', () => {
    const card = I.parseCard('只有正文，没有 frontmatter。', '/x/03-Knowledge/手写卡.md')
    assert.equal(card.title, '手写卡')
    assert.equal(card.body, '只有正文，没有 frontmatter。')
    assert.equal(card.kind, '03-Knowledge', 'kind 应从目录名回落')
  })

  it('BOM 与 CRLF 不破坏解析', () => {
    const raw = '\uFEFF---\r\ntitle: CRLF 卡\r\ntags: [a]\r\n---\r\n\r\n正文\r\n'
    const card = I.parseCard(raw, '/x/03-Knowledge/c.md')
    assert.equal(card.title, 'CRLF 卡')
    assert.equal(card.body.trim(), '正文')
  })
})

// ─────────────────── 3. slug 与 kind 三道闸 ───────────────────

describe('slug 与 kind 匹配', () => {
  it('slug 保留中英文数字，压掉非法字符', () => {
    assert.equal(I.slugify('Hello World'), 'Hello-World')
    assert.equal(I.slugify('a/b\\c:d*e?f'), 'a-b-c-d-e-f')
    assert.equal(I.slugify('  '), 'card')
    assert.equal(I.slugify('中文 标题（括号）'), '中文-标题（括号）')
    // 上限按**字节**算（150），不再是旧的 60 字符：中文一个字 3 字节，
    // 按字符截会让长中文标题顶到文件名上限；150 字节也让长标题不容易撞车。
    assert.ok(I.slugify('x'.repeat(200)).length <= 150)
    assert.ok(Buffer.byteLength(I.slugify('中'.repeat(200)), 'utf8') <= 150)
  })

  const kinds = new Set(I.KINDS.map(([d]) => d))

  it('闸1 精确：目录名与短名', () => {
    assert.equal(I.matchKind('08-Mistakes', kinds), '08-Mistakes')
    assert.equal(I.matchKind('mistakes', kinds), '08-Mistakes')
    assert.equal(I.matchKind('Mistakes', kinds), '08-Mistakes')
    assert.equal(I.matchKind('', kinds), I.DEFAULT_KIND, '空 kind 落默认目录')
  })

  it('闸2 归一化：忽略大小写/连字符/下划线', () => {
    assert.equal(I.matchKind('MISTAKE', kinds), '08-Mistakes')
    assert.equal(I.matchKind('08_mistakes', kinds), '08-Mistakes')
    assert.equal(I.matchKind('08 mistakes', kinds), '08-Mistakes')
  })

  it('闸3 近似：互为子串', () => {
    assert.equal(I.matchKind('mistake-card', kinds), '08-Mistakes')
    assert.equal(I.matchKind('knowledge-base', kinds), '03-Knowledge')
  })

  it('三道都不中 → undefined（交给调用方建目录）', () => {
    assert.equal(I.matchKind('量子纠缠笔记', kinds), undefined)
  })

  it('建新目录用 NN-slug 且只建一级，编号递增', () => {
    const { dir } = tempLibrary()
    fs.mkdirSync(path.join(dir, '08-Mistakes'), { recursive: true })
    const made = I.createKindDir(dir, new Set([...kinds]), '量子笔记')
    assert.equal(made, '09-量子笔记')
    assert.ok(fs.existsSync(path.join(dir, made)))
    assert.ok(fs.statSync(path.join(dir, made)).isDirectory())
    const again = I.createKindDir(dir, new Set([...kinds, made]), 'second thing')
    assert.equal(again, '10-Second-thing')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ─────────────────── 4. 长度闸与重叠率 ───────────────────

describe('长度控制与重叠检测', () => {
  it('bigram 重叠率：相同=1，无关≈0，改写=中等', () => {
    assert.equal(I.bigramOverlap('完全一样的内容', '完全一样的内容'), 1)
    assert.equal(I.bigramOverlap('abcdefghij', '1234567890'), 0)
    const a = '插件放在 vendor 目录下，profile 的 package.json 需要改两处'
    const b = '插件放在 vendor 目录下，profile 的 package.json 需要改两处（已验证）'
    assert.ok(I.bigramOverlap(a, b) > 0.6, '真补充的改写应被判为高重合')
    const c = '完全无关的另一件事：今天天气不错，适合出门散步'
    assert.ok(I.bigramOverlap(a, c) < 0.6)
  })

  it('摘要只从正文截，跳过标题与引用，压平换行', () => {
    const body = '# 标题\n\n> 引用行\n\n正文第一段。\n\n正文第二段。'
    assert.equal(I.summarize(body), '正文第一段。 正文第二段。')
    const long = I.summarize('字'.repeat(400))
    assert.equal([...long].length, 151, '150 字 + 省略号')
    assert.ok(long.endsWith('…'))
  })
})

// ─────────────────── 5. 敏感信息扫描 ───────────────────

describe('敏感信息扫描', () => {
  it('命中常见密钥模式', () => {
    assert.ok(I.scanSensitive('key = sk-abcdefghijklmnopqrstuvwx'))
    assert.ok(I.scanSensitive('token: ghp_abcdefghijklmnopqrstuvwxyz01'))
    assert.ok(I.scanSensitive('AKIAIOSFODNN7EXAMPLE'))
    assert.ok(I.scanSensitive('-----BEGIN RSA PRIVATE KEY-----'))
    assert.ok(I.scanSensitive('api_key: "abcdefghijklmnopqrstuvwxyz123456"'))
  })

  it('正常文本不误伤', () => {
    assert.equal(I.scanSensitive('一段普通中文文本，含一个路径 C:\\test'), null)
    assert.equal(I.scanSensitive('sk- 只是一个前缀说明'), null)
    assert.equal(I.scanSensitive('token 这个字段有 3 个值'), null)
  })
})

// ─────────────────── 6. 图片引用识别 ───────────────────

describe('图片引用', () => {
  it('识别 markdown 与 wiki 两种语法，跳过 http', () => {
    const body = [
      '前文 ![说明](C:\\pics\\a.png) 中间 ![[C:\\pics\\b.jpg]] 后文',
      '外链 ![x](https://e.com/c.png) 不算',
      '库内 ![y](_assets/slug/d.png) 跳过',
    ].join('\n')
    const refs = I.findImageRefs(body)
    assert.equal(refs.length, 2)
    assert.ok(refs.some(r => r.rawPath === 'C:\\pics\\a.png'))
    assert.ok(refs.some(r => r.rawPath === 'C:\\pics\\b.jpg'))
  })

  it('搬运图片：复制进 _assets/<slug>/ 并原地改写，正文其他字不动', () => {
    const { dir, config } = tempLibrary()
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viya-pics-'))
    const img = path.join(srcDir, 'shot.png')
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const body = `看这张图 ![截图](${img}) 就懂了。\n\n完。`
    const out = I.relocateImages(config, 'some-card', body)
    assert.equal(out.moved.length, 1)
    assert.ok(out.body.includes('![截图](_assets/some-card/shot.png)'), '路径要原地改写')
    assert.ok(out.body.includes(`看这张图 ![截图](_assets/some-card/shot.png) 就懂了。`), '位置与文字不能变')
    assert.ok(fs.existsSync(path.join(dir, '_assets', 'some-card', 'shot.png')), '文件要真的复制过去')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(srcDir, { recursive: true, force: true })
  })

  it('图片不存在时保留原路径并如实报告', () => {
    const { dir, config } = tempLibrary()
    const out = I.relocateImages(config, 'c', '![x](C:\\not\\here.png)')
    assert.equal(out.moved.length, 0)
    assert.equal(out.missing.length, 1)
    assert.equal(out.body, '![x](C:\\not\\here.png)')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ─────────────────── 7. 检索打分 ───────────────────

describe('检索', () => {
  const mk = (over = {}) => ({
    title: 'x', tags: [], keywords: [], importance: 3, body: '', links: [], ...over,
  })

  it('query 解析：`|` 分组、`*` 通配、只传 * 返回全部', () => {
    assert.deepEqual(I.parseQuery('*'), { all: true, groups: [] })
    assert.deepEqual(I.parseQuery(''), { all: true, groups: [] })
    assert.deepEqual(I.parseQuery('a|b').groups, ['a', 'b'])
    assert.equal(I.parseQuery('a|b').all, false)
  })

  it('权重：标题 ×3 > 标签 ×2 > 正文 ×1', () => {
    const p = I.parseQuery('mtime')
    const byTitle = I.scoreCard(mk({ title: 'mtime 检查' }), p).score
    const byTag = I.scoreCard(mk({ tags: ['mtime'] }), p).score
    const byBody = I.scoreCard(mk({ body: '关于 mtime 的说明' }), p).score
    assert.ok(byTitle > byTag, '标题应高于标签')
    assert.ok(byTag > byBody, '标签应高于正文')
  })

  it('多关键词是 AND：缺一个就淘汰', () => {
    const p = I.parseQuery('mtime|并发')
    assert.equal(I.scoreCard(mk({ title: 'mtime 只能说明' }), p), null)
    assert.ok(I.scoreCard(mk({ title: 'mtime 与并发写冲突' }), p) !== null)
  })

  it('词内 * 通配能匹配上', () => {
    const p = I.parseQuery('并发*冲突')
    assert.ok(I.scoreCard(mk({ body: '并发写冲突的处理' }), p) !== null)
    assert.equal(I.scoreCard(mk({ body: '并发写完了' }), p), null)
  })

  it('特殊字符不当正则用（中文括号、+、?）', () => {
    const p = I.parseQuery('a+b(c)?')
    assert.ok(I.scoreCard(mk({ title: 'a+b(c)? 字面量' }), p) !== null)
    assert.equal(I.scoreCard(mk({ title: 'axxxbxc' }), p), null)
  })

  it('重要性提供小幅加权', () => {
    const p = I.parseQuery('x')
    const low = I.scoreCard(mk({ title: 'x', importance: 1 }), p).score
    const high = I.scoreCard(mk({ title: 'x', importance: 5 }), p).score
    assert.ok(high > low)
    assert.ok(high / low < 1.3, '加权幅度要小，不能压过命中本身')
  })
})

// ─────────────────── 8. 七个工具的真实执行路径（内存库）───────────────────

describe('工具真实调用（临时库）', () => {
  let lib, tools

  before(() => {
    lib = tempLibrary()
    const made = makeCtx()
    tools = made.tools
    mod.apply(made.ctx, lib.config)
  })

  after(() => {
    fs.rmSync(lib.dir, { recursive: true, force: true })
  })

  const call = (name, args) => tools.get(name).execute(args, {})

  it('memory_save 新建卡：落到默认目录、frontmatter 正确、正文为传入内容', async () => {
    const r = await call('memory_save', {
      title: '并发写冲突',
      content: '写入前比 mtime，外部改过就拒绝覆盖。',
      tags: ['技术', 'DSH'],
      keywords: 'mtime, 乐观并发, optimistic concurrency',
      importance: 4,
    })
    assert.equal(r.words > 0, true)
    const file = path.join(lib.dir, '03-Knowledge', '并发写冲突.md')
    assert.ok(fs.existsSync(file), `应落在 ${file}`)
    const raw = fs.readFileSync(file, 'utf8')
    assert.ok(raw.startsWith('---\nformatVersion: 1\n'))
    assert.ok(raw.includes('kind: 03-Knowledge'))
    assert.ok(raw.includes('importance: 4'))
    assert.ok(raw.includes('mtime'))
    const parsed = I.parseCard(raw, file)
    assert.deepEqual(parsed.tags, ['技术', 'DSH'])
    assert.equal(parsed.keywords.length, 3)
    assert.equal(parsed.body, '写入前比 mtime，外部改过就拒绝覆盖。')
  })

  it('memory_save 撞同名且高度重合 → 跳过不写', async () => {
    const before = fs.readFileSync(path.join(lib.dir, '03-Knowledge', '并发写冲突.md'), 'utf8')
    const r = await call('memory_save', {
      title: '并发写冲突',
      content: '写入前比 mtime，外部改过就拒绝覆盖。',
    })
    assert.ok(r.action.includes('跳过'), `应跳过，实际：${r.action}`)
    assert.equal(fs.readFileSync(path.join(lib.dir, '03-Knowledge', '并发写冲突.md'), 'utf8'), before, '文件不该被动')
  })

  it('memory_save 撞同名但真有补充 → 另起 ## 更新 节，报警字数', async () => {
    const r = await call('memory_save', {
      title: '并发写冲突',
      content: '补充：跨进程场景另有风险，尚未处理。',
    })
    assert.ok(r.action.includes('追加更新节'), `应追加，实际：${r.action}`)
    const raw = fs.readFileSync(path.join(lib.dir, '03-Knowledge', '并发写冲突.md'), 'utf8')
    assert.ok(raw.includes('## 更新 '), '必须成节，不是粘一段散字')
    assert.ok(raw.includes('补充：跨进程场景另有风险'), '新内容要在')
    assert.ok(raw.includes('写入前比 mtime'), '原内容不能丢')
  })

  it('memory_save 追加后超硬限 → 报错并提示重写', async () => {
    await assert.rejects(
      () => call('memory_save', { title: '并发写冲突', content: '长'.repeat(790) + '补充新内容完全不同' }),
      /硬限/,
    )
  })

  it('memory_save 超硬限的新卡 → 报错并提示「卡 + 指针」', async () => {
    await assert.rejects(
      () => call('memory_save', { title: '一张超长的卡', content: '字'.repeat(801) }),
      /卡 \+ 指针|硬限/,
    )
  })

  it('memory_save 命中敏感信息 → 拒绝写入', async () => {
    await assert.rejects(
      () => call('memory_save', { title: '泄漏的密钥', content: 'key = sk-abcdefghijklmnopqrstuvwx' }),
      /敏感信息/,
    )
    assert.ok(!fs.existsSync(path.join(lib.dir, '03-Knowledge', '泄漏的密钥.md')))
  })

  it('memory_save 未知 kind → 自动建 NN-slug 目录并报备', async () => {
    const r = await call('memory_save', { title: '一张野生卡', content: '内容足够不同的一堆字。', kind: '量子笔记' })
    assert.ok(r.action.includes('已新建目录'), `要报备新目录，实际：${r.action}`)
    assert.ok(fs.existsSync(path.join(lib.dir, '09-量子笔记', '一张野生卡.md')))
  })

  it('memory_search 能搜到标题命中并按分排序', async () => {
    const r = await call('memory_search', { query: 'mtime|并发' })
    assert.ok(r.returned >= 1)
    assert.equal(r.results[0].title, '并发写冲突')
    assert.ok(r.results[0].summary.length > 0)
    assert.ok(r.results[0].score > 0)
    assert.equal(typeof r.results[0].hasImage, 'boolean')
  })

  it('memory_search 关键词锚点也能命中（写卡时提炼的检索锚点）', async () => {
    const r = await call('memory_search', { query: 'optimistic concurrency' })
    assert.ok(r.returned >= 1, '英文锚点应该能搜到中文卡')
    assert.equal(r.results[0].title, '并发写冲突')
  })

  it('memory_search 的 tags 是过滤（必须含）', async () => {
    assert.ok((await call('memory_search', { query: '*', tags: ['技术'] })).returned >= 1)
    assert.equal((await call('memory_search', { query: '*', tags: ['不存在的标签'] })).returned, 0)
  })

  it('memory_search 时间过滤与 threshold 生效', async () => {
    assert.equal((await call('memory_search', { query: '*', end_time: '2000-01-01' })).returned, 0)
    assert.ok((await call('memory_search', { query: '*', start_time: '2000-01-01' })).returned >= 1)
    assert.equal((await call('memory_search', { query: '*', threshold: 99999 })).returned, 0)
  })

  it('memory_read 能按标题与按路径读，附上图片绝对路径', async () => {
    const byTitle = await call('memory_read', { title: '并发写冲突' })
    assert.equal(byTitle.found, true)
    assert.ok(byTitle.body.includes('mtime'))
    assert.equal(byTitle.status, 'approved')
    const byPath = await call('memory_read', { path: byTitle.path })
    assert.equal(byPath.title, '并发写冲突')
  })

  it('memory_read 查不到 → 明确说「记忆不存在」，不猜', async () => {
    const r = await call('memory_read', { title: '根本没这回事' })
    assert.equal(r.found, false)
    const rendered = tools.get('memory_read').output.render({}, r)
    assert.ok(rendered[0].text.includes('记忆不存在'))
  })

  it('memory_update 改正文/标签并刷新 updated，created 不动', async () => {
    const before = await call('memory_read', { title: '并发写冲突' })
    const meta = I.parseCard(fs.readFileSync(before.path, 'utf8'), before.path)
    const r = await call('memory_update', {
      title: '并发写冲突',
      content: '精炼后的结论：写入前比 mtime，外部改过就拒绝覆盖。',
      tags: ['技术'],
      importance: 5,
      keywords: 'mtime, 冲突',
    })
    assert.ok(r.changed.includes('正文'))
    assert.ok(r.changed.includes('tags'))
    const after = I.parseCard(fs.readFileSync(before.path, 'utf8'), before.path)
    assert.equal(after.created, meta.created, 'created 不能动')
    assert.equal(after.importance, 5)
    assert.deepEqual(after.tags, ['技术'])
    assert.deepEqual(after.keywords, ['mtime', '冲突'])
    assert.equal(after.body, '精炼后的结论：写入前比 mtime，外部改过就拒绝覆盖。')
  })

  it('memory_update 改不存在的卡 → 报错', async () => {
    await assert.rejects(() => call('memory_update', { title: '不存在的卡', content: 'x' }), /记忆不存在/)
  })

  it('memory_update 非法 status → 报错', async () => {
    await assert.rejects(() => call('memory_update', { title: '并发写冲突', status: 'draft' }), /status/)
  })

  it('memory_link 连两张卡：两边都有 [[对方]] 与 links', async () => {
    await call('memory_save', { title: '被连的卡', content: '这是一张等着被连起来的卡，内容独立。', kind: 'projects' })
    const r = await call('memory_link', {
      source: '并发写冲突', target: '被连的卡', type: 'explains', weight: 0.8, description: '互为因果',
    })
    assert.equal(r.status, 'created')
    const s = await call('memory_read', { title: '并发写冲突' })
    const t = await call('memory_read', { title: '被连的卡' })
    assert.ok(s.body.includes('[[被连的卡]]'), '源卡正文要有对方双链')
    assert.ok(t.body.includes('[[并发写冲突]]'), '目标卡正文要有对方双链（不许单向边）')
    const sc = I.parseCard(fs.readFileSync(s.path, 'utf8'), s.path)
    const tc = I.parseCard(fs.readFileSync(t.path, 'utf8'), t.path)
    assert.equal(sc.links.find(l => l.target === '被连的卡').type, 'explains')
    assert.equal(tc.links.find(l => l.target === '并发写冲突').weight, 0.8)
  })

  // 与上一条分开：这里只问「完全一样的边再来一次会不会重复写」，
  // 所以参数带全——不然缺省的 related 会去改上一条测试留下的 contradicts 边。
  it('memory_link 重复连边 → 跳过不重复写', async () => {
    const r = await call('memory_link', {
      source: '并发写冲突', target: '被连的卡', type: 'explains', weight: 0.8, description: '互为因果',
    })
    assert.equal(r.status, 'already-linked')
  })

  // 2026-09-27 实测事故：标签/关键词里的逗号被 `split(',')` 劈成两个元素，
  // 落盘后 Obsidian 与插件自己都读成两个标签，且 tags 过滤再也匹配不上。
  it('数组元素含逗号 → 往返不劈开，tags 过滤仍能命中', async () => {
    const both = ['标签1,标签2', '普通']
    const host = I.parseCard(
      I.serializeCard({ title: '逗号卡', tags: both, keywords: ['k1,k2'], body: 'x' }),
      '/x/03-Knowledge/t.md',
    )
    assert.deepEqual(host.tags, both, '标签被逗号劈开了')
    assert.deepEqual(host.keywords, ['k1,k2'], '关键词被逗号劈开了')

    await call('memory_save', { title: '标签过滤卡', content: '逗号标签的过滤验证。', tags: both })
    const hit = await call('memory_search', { query: '*', tags: ['标签1,标签2'] })
    assert.equal(hit.total, 1, '含逗号的完整标签必须能命中')
    const miss = await call('memory_search', { query: '*', tags: ['标签2'] })
    assert.equal(miss.total, 0, '被劈开的半截标签不该命中')
  })

  // 同源第二个事故：边描述里的逗号把后面的字段吃掉（type 退回 related、描述被截断）。
  it('内联对象含逗号/引号 → 字段不串扰，描述不丢', async () => {
    const obj = I.parseInlineObject("{target: B, type: explains, weight: 0.8, description: 说明含逗号, 后半}")
    assert.equal(obj.type, 'explains')
    assert.equal(obj.weight, 0.8)
    assert.equal(obj.description, '说明含逗号, 后半')

    const card = I.parseCard(
      I.serializeCard({
        title: 'A',
        tags: ['x'],
        links: [{ target: 'B', type: 'contradicts', weight: 0.9, description: '带,逗号 与 \'单引号\'' }],
        body: 'x',
      }),
      '/x/03-Knowledge/a.md',
    )
    const edge = card.links.find(l => l.target === 'B')
    assert.equal(edge.type, 'contradicts', '关系类型被逗号吃掉了')
    assert.equal(edge.weight, 0.9)
    assert.ok(edge.description.includes('单引号'), '描述里的引号丢了')
  })

  // 原实现按「目标卡」去重：同一对卡连不上第二种关系，且正文 callout 与 frontmatter 打架。
  it('memory_link 支持同目标不同类型；未提供的字段不覆盖已有边', async () => {
    await call('memory_save', { title: '边测试A', content: 'A 卡内容独立。', kind: 'projects' })
    await call('memory_save', { title: '边测试B', content: 'B 卡内容独立。', kind: 'projects' })
    const first = await call('memory_link', {
      source: '边测试A', target: '边测试B', type: 'related', weight: 0.8, description: '先相关',
    })
    assert.equal(first.status, 'created')

    // 不给 weight/description → 是「没说」，不该把 0.8 冲成 0.7
    const same = await call('memory_link', { source: '边测试A', target: '边测试B', type: 'related' })
    assert.equal(same.status, 'already-linked', '完全重复的边应当跳过')
    const keep = I.parseCard(
      fs.readFileSync((await call('memory_read', { title: '边测试A' })).path, 'utf8'),
      '/x/03-Knowledge/a.md',
    )
    assert.equal(keep.links.find(l => l.target === '边测试B').weight, 0.8, '没给 weight 却被覆盖了')

    // 换成另一种关系 → 应当更新，而不是拒绝
    const change = await call('memory_link', { source: '边测试A', target: '边测试B', type: 'contradicts' })
    assert.equal(change.status, 'updated', '同一对卡应当能改关系类型')
    const after = I.parseCard(
      fs.readFileSync((await call('memory_read', { title: '边测试B' })).path, 'utf8'),
      '/x/03-Knowledge/b.md',
    )
    assert.equal(after.links.find(l => l.target === '边测试A').type, 'contradicts')
    assert.ok(after.body.includes('> contradicts:'), '正文 callout 必须跟着换成新类型')
  })

  // IMAGE_EXT 原先定义完从没被用过：任何后缀都会被当本地图片拷进库。
  // 2026-09-27：Obsidian 里手写 `tags: 技术`（标量）会被旧代码当非数组**整组丢掉**，
  // 而且下一次写入会把字段彻底抹平；`keywords: a, b` 同理。
  it('tags/keywords 写成标量也不丢（兼容手写卡）', () => {
    const one = I.parseCard('---\ntitle: t\ntags: 技术\n---\n正文', '/x/03-Knowledge/t.md')
    assert.deepEqual(one.tags, ['技术'], '单个标量标签不该丢')
    const many = I.parseCard('---\ntitle: t\nkeywords: mtime, 并发, 冲突\n---\n正文', '/x/03-Knowledge/t.md')
    assert.deepEqual(many.keywords, ['mtime', '并发', '冲突'], '逗号分隔的标量关键词不该丢')
    assert.deepEqual(I.asStringList(undefined), [])
    assert.deepEqual(I.asStringList(['a', ' ', 'b']), ['a', 'b'], '数组里的空项要清掉')
  })

  // 2026-09-27 对抗审查实测：值里带换行会把 frontmatter 写成两行，
  // 回读时多出一条假边 / 整组标签变空。frontmatter 是逐行解析的，值必须单行化。
  it('值里的换行被压成单行，不写坏 frontmatter', async () => {
    assert.equal(I.flattenLine('a\nb'), 'a b')
    assert.equal(I.flattenLine('a\r\nb\r\n'), 'a b')
    const card = I.parseCard(
      I.serializeCard({ title: 't', tags: ['ok', 'a\nb'], keywords: ['x\ny'], body: 'b' }),
      '/x/03-Knowledge/t.md',
    )
    assert.deepEqual(card.tags, ['ok', 'a b'], '带换行的标签把整组写坏了')
    assert.deepEqual(card.keywords, ['x y'])

    await call('memory_save', { title: '换行源卡', content: '源卡内容独立。', kind: 'projects' })
    await call('memory_save', { title: '换行目标卡', content: '目标卡内容独立。', kind: 'projects' })
    await call('memory_link', { source: '换行源卡', target: '换行目标卡', description: 'a\nb' })
    const r = await call('memory_read', { title: '换行源卡' })
    const back = I.parseCard(fs.readFileSync(r.path, 'utf8'), r.path)
    assert.equal(back.links.length, 1, `带换行的描述写出了假边：${JSON.stringify(back.links)}`)
    assert.equal(back.links[0].description, 'a b')
    assert.ok(back.body.includes('（a b）'), '正文 callout 里的描述也被换行截断了')
  })

  it('图片只认图片后缀；相对路径按库根解析', async () => {
    assert.equal(I.isLocalImagePath('a.png'), true)
    assert.equal(I.isLocalImagePath('a.svg'), true)
    assert.equal(I.isLocalImagePath('a.avif'), true)
    assert.equal(I.isLocalImagePath('a.md'), false, '非图片后缀不该被当本地图片')
    assert.equal(I.isLocalImagePath('a.txt'), false)
    assert.equal(I.isLocalImagePath('a.verylongext'), false, '长后缀不该漏网')
    assert.equal(I.isLocalImagePath('图.1'), true, '点+数字不是扩展名，照旧当本地路径')
    assert.equal(I.isLocalImagePath('https://x/a.png'), false)
    const dir = tempLibrary().dir
    assert.equal(
      I.resolveImagePath('./attachments/a.png', dir),
      path.join(dir, 'attachments/a.png'),
      '带目录的相对路径必须以库根为基准',
    )
    assert.equal(
      I.resolveImagePath('a.png', dir),
      path.join(dir, 'a.png'),
      '裸文件名也要以库根为基准（不能再跟进程 cwd 跑）',
    )
  })

  // 2026-09-27：给 findCard 加库根回落时不能连库外一起放进来——
  // memory_forget 是会真把文件搬进 _trashed 的。
  it('库内相对路径可读；相对路径不许越出库根', async () => {
    await call('memory_save', { title: '库内卡', content: '库内卡内容独立。', kind: 'projects' })
    const relPath = path.join(lib.dir, '02-Projects', '库内卡.md')
    assert.equal(fs.existsSync(relPath), true, '前置条件：文件确实在库内')
    const got = await call('memory_read', { title: '02-Projects/库内卡.md' })
    assert.ok(got.body.includes('库内卡内容独立'), '库内相对路径应当能读到')

    const outside = path.join(path.dirname(lib.dir), 'outside-probe.md')
    fs.writeFileSync(outside, '---\ntitle: 库外卡\n---\n库外内容', 'utf8')
    // 注意：memory_read 对找不到的卡是**返回 found:false**（不抛异常），按契约断言这一点
    const escaped = await call('memory_read', { title: '../outside-probe.md' })
    assert.equal(escaped.found, false, '../ 相对路径不该读到库外文件')
    assert.equal(escaped.body, '', '不该把库外内容带出来')
    assert.equal(fs.existsSync(outside), true, '库外文件必须原样还在')
    // 而绝对路径依然可用（工具文档承诺支持）：同一张卡用绝对路径能读
    const byAbs = await call('memory_read', { title: relPath })
    assert.equal(byAbs.found, true, '库内绝对路径必须仍能读')
    fs.rmSync(outside, { force: true })
  })

  // 2026-09-27 实测：标题前 60 字相同的两张卡撞同一文件名，第二张被判「重合」静默拒写。
  it('长标题截断后不撞车：不同标题各写各的，不误判重合', async () => {
    const base = 'A'.repeat(80)
    const r1 = await call('memory_save', { title: `${base}第一部分`, content: '第一张卡，讲主题甲。', kind: 'projects' })
    const r2 = await call('memory_save', { title: `${base}第二部分`, content: '第二张卡，讲主题乙。', kind: 'projects' })
    assert.equal(r2.action.startsWith('跳过'), false, `第二张被误判重合拒写了：${r2.action}`)
    assert.notEqual(r1.path, r2.path, '两个不同标题不该落到同一个文件')
    const c1 = I.parseCard(fs.readFileSync(r1.path, 'utf8'), r1.path)
    const c2 = I.parseCard(fs.readFileSync(r2.path, 'utf8'), r2.path)
    assert.equal(c1.title, `${base}第一部分`)
    assert.equal(c2.title, `${base}第二部分`)
  })

  // 中文按字节算：150 字节上限，不能再出现旧上限下 60 个汉字就截断的情况
  it('slug 按字节安全截断，不越过文件名上限', () => {
    const long = '中'.repeat(200)
    const s = I.slugify(long)
    assert.ok(Buffer.byteLength(s, 'utf8') <= 150, `slug 字节数 ${Buffer.byteLength(s, 'utf8')} 超过 150`)
    assert.ok(s.startsWith('中'), '不该把整个 slug 丢掉')
    assert.equal(I.slugify('Hello World'), 'Hello-World')
    assert.equal(I.slugify('   '), 'card', '全空回落 fallback')
  })

  // memory_read 保留「能读库外文件」的既有能力（它要详情与附件绝对路径）；
  // 但 memory_forget 会把文件搬进 _trashed，绝不能被同一条路径带出库。
  it('memory_read 可读库外；memory_forget 不许动库外', async () => {
    const outside = path.join(path.dirname(lib.dir), 'outside-read-probe.md')
    fs.writeFileSync(outside, '---\ntitle: 库外详情卡\n---\n库外内容', 'utf8')
    const r = await call('memory_read', { title: outside })
    assert.equal(r.found, true, '库外文件应当能读（这是 memory_read 的既有能力）')
    assert.ok(r.body.includes('库外内容'))
    const f = await call('memory_forget', { title: outside })
    assert.equal(f.mode, 'not-found', 'memory_forget 不该碰库外文件（它用 mode 表达结果）')
    assert.equal(fs.existsSync(outside), true, '库外文件必须原样还在')
    // 也试一下用「标题」去命中库外那张卡：同样必须拒绝
    const byTitle = await call('memory_forget', { title: '库外详情卡' })
    assert.equal(byTitle.mode, 'not-found', '用标题也不许把库外卡删掉')
    assert.equal(fs.existsSync(outside), true, '库外文件必须原样还在')
    fs.rmSync(outside, { force: true })
  })

  // 2026-09-27：换 type 时旧边的 weight/description 属于旧关系，不该被默认继承
  // （related 0.8 → contradicts 之后仍是 0.8，语义错配）。
  it('memory_link 换类型时重置权重与说明（除非显式给出）', async () => {
    await call('memory_save', { title: '换型A', content: 'A 内容独立。', kind: 'projects' })
    await call('memory_save', { title: '换型B', content: 'B 内容独立。', kind: 'projects' })
    await call('memory_link', { source: '换型A', target: '换型B', type: 'related', weight: 0.9, description: '旧说明' })
    const sv = await call('memory_link', { source: '换型A', target: '换型B', type: 'explains' })
    assert.equal(sv.status, 'updated')
    const after = I.parseCard(fs.readFileSync((await call('memory_read', { title: '换型A' })).path, 'utf8'), '/x/t.md')
    const edge = after.links.find(l => l.target === '换型B')
    assert.equal(edge.type, 'explains')
    assert.equal(edge.weight, 0.7, '换类型后应落回默认权重，而不是继承旧关系的 0.9')
    assert.equal(edge.description, '', '换类型后旧说明不该跟过来')
    assert.ok(after.body.includes('> explains: [[换型B]]'), '正文 callout 也要换成新类型')
    // 显式给了就按给的来
    await call('memory_link', { source: '换型A', target: '换型B', type: 'causes', weight: 0.3, description: '新说明' })
    const after2 = I.parseCard(fs.readFileSync((await call('memory_read', { title: '换型A' })).path, 'utf8'), '/x/t.md')
    const e2 = after2.links.find(l => l.target === '换型B')
    assert.equal(e2.weight, 0.3)
    assert.equal(e2.description, '新说明')
  })

  it('memory_link 一边找不到 → 整条不写，不留单向边', async () => {
    const before = fs.readFileSync(
      (await call('memory_read', { title: '被连的卡' })).path, 'utf8',
    )
    await assert.rejects(
      () => call('memory_link', { source: '并发写冲突', target: '压根不存在的卡' }),
      /不存在/,
    )
    const after = fs.readFileSync((await call('memory_read', { title: '被连的卡' })).path, 'utf8')
    assert.equal(after, before, '另一张卡不能被改动')
  })

  it('memory_stats 体检：分布、死链、超长卡', async () => {
    await call('memory_save', { title: '带死链的卡', content: '这里指向 [[一张不存在的卡]]，用于体检测试。', kind: 'mistakes', severity: 'warn' })
    const r = await call('memory_stats', {})
    assert.ok(r.total >= 4, `总卡数应 >= 4，实际 ${r.total}`)
    // 至少两个目录、且总数与分布一致（这是体检的核心：分布要可信）
    assert.ok(r.kinds.length >= 2, `应至少有两个目录，实际 ${JSON.stringify(r.kinds)}`)
    assert.equal(r.kinds.reduce((n, k) => n + k.count, 0), r.total, '分布总数必须等于总卡数')
    assert.ok(r.kinds.some(k => k.dir === '08-Mistakes' && k.count >= 1), '08-Mistakes 应有卡')
    assert.ok(r.deadLinks.some(l => l.includes('一张不存在的卡')), '死链要报出来')
    assert.equal(typeof r.trashed, 'number')
  })

  // 2026-09-28 事故后加的硬闸：不传 confirm 一律不落手。
  // 背景：误删的根因不是「不知道规矩」，而是「执行时没人拦」——提示词约束不了执行者。
  it('memory_forget 不传 confirm → 只预览，一个字节都不动', async () => {
    const before = fs.readFileSync(path.join(lib.dir, '08-Mistakes', '带死链的卡.md'), 'utf8')
    const p = await call('memory_forget', { title: '带死链的卡' })
    assert.equal(p.mode, 'preview', '缺省必须只预览')
    assert.ok(p.path.includes('带死链的卡'), '预览要给出目标路径')
    assert.ok(Number.isInteger(p.referrers), '要报告有多少卡引用了它')
    // 关键断言：预览之后磁盘必须**逐字节**不变
    const after = fs.readFileSync(path.join(lib.dir, '08-Mistakes', '带死链的卡.md'), 'utf8')
    assert.equal(after, before, '预览绝不许动文件')
    const stillThere = await call('memory_search', { query: '死链' })
    assert.ok(stillThere.returned > 0, '预览后卡片仍应被检索到')
  })

  it('memory_forget 传 confirm: true 才真删 → status: deleted + 移进 _trashed/', async () => {
    const r = await call('memory_forget', { title: '带死链的卡', confirm: true })
    assert.equal(r.mode, 'trashed')
    assert.ok(r.path.includes('_trashed'), `应落进回收站，实际 ${r.path}`)
    assert.ok(fs.existsSync(r.path))
    assert.ok(fs.readFileSync(r.path, 'utf8').includes('status: deleted'))
    assert.ok(!fs.existsSync(path.join(lib.dir, '08-Mistakes', '带死链的卡.md')), '原位置要清掉')
  })

  it('memory_forget 软删后不该被检索到', async () => {
    const r = await call('memory_search', { query: '死链' })
    assert.equal(r.returned, 0)
  })

  it('memory_forget permanent 也要 confirm（双保险）', async () => {
    await call('memory_save', { title: '永久删预览卡', content: '用于验证 permanent 也受 confirm 保护。' })
    const p = await call('memory_forget', { title: '永久删预览卡', permanent: true })
    assert.equal(p.mode, 'preview', 'permanent 缺 confirm 时也只能预览')
    assert.ok(fs.existsSync(p.path), '文件必须还在')
    const gone = await call('memory_forget', { title: '永久删预览卡', permanent: true, confirm: true })
    assert.equal(gone.mode, 'deleted')
    assert.equal(fs.existsSync(gone.path), false, '这次才真的删')
  })

  it('memory_forget 不存在的卡 → not-found，不报错', async () => {
    const r = await call('memory_forget', { title: '从没写过的东西' })
    assert.equal(r.mode, 'not-found')
  })

  it('mtime 乐观并发：外部改过之后写 → 拒绝并回报', async () => {
    const read = await call('memory_read', { title: '被连的卡' })
    // 模拟外部手改（mtime 前进）
    fs.writeFileSync(read.path, fs.readFileSync(read.path, 'utf8') + '\n\n我手改的一行', 'utf8')
    await new Promise(r => setTimeout(r, 20))
    const next = fs.readFileSync(read.path, 'utf8') + '\n又改'
    fs.writeFileSync(read.path, next, 'utf8')
    // 从工具视角：先读旧 mtime，再写；中间被人改过 → stale
    const stale = I.atomicWrite(lib.config, read.path, 'new content', 1)
    assert.equal(stale.ok, false)
    assert.equal(stale.reason, 'stale')
  })
})

// ─────────────────── 9. 端到端冒烟（临时目录，真文件系统）───────────────────

describe('端到端冒烟测试', () => {
  const TEST_TITLE = '【自测卡请删除】viya-memory smoke test'

  it('在真文件系统上写卡 → 读回 → 搜到 → 删干净', async () => {
    // 用系统临时目录在真文件系统上跑完整链路：任何机器上都能跑，
    // 也不会碰到谁的私有 vault（上一版这里指向开发者的固定路径，已改掉）。
    const REAL_LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'viya-smoke-'))
    const { ctx, tools } = makeCtx()
    mod.apply(ctx, { library: REAL_LIB, hardLimit: 800, searchBudget: 2000, sensitiveScan: true })
    const call = (name, args) => tools.get(name).execute(args, {})

    let cardPath = null
    try {
      const saved = await call('memory_save', {
        title: TEST_TITLE,
        content: '这是 viya-memory 插件的自测卡，验证写卡链路。看到它请直接删除。',
        kind: 'knowledge',
        tags: ['自测'],
        keywords: 'smoke test, 自测, viya-memory',
      })
      cardPath = saved.path
      assert.ok(fs.existsSync(cardPath), '卡文件应该真的落盘')
      const raw = fs.readFileSync(cardPath, 'utf8')
      assert.ok(raw.startsWith('---\nformatVersion: 1'))

      const read = await call('memory_read', { title: TEST_TITLE })
      assert.equal(read.found, true)
      assert.ok(read.body.includes('自测卡'))

      const found = await call('memory_search', { query: 'viya-memory|自测' })
      assert.ok(found.results.some(r => r.title === TEST_TITLE), '刚写的卡要能搜到')

      const stats = await call('memory_stats', {})
      assert.ok(stats.total >= 1)
    } finally {
      // 临时库整个删掉，不留任何痕迹
      fs.rmSync(REAL_LIB, { recursive: true, force: true })
    }
    assert.ok(!fs.existsSync(cardPath), '自测卡必须删干净')
    assert.ok(!fs.existsSync(REAL_LIB), '临时库必须整个清掉')
  })
})

// ─────────────────── 10. user.md 注入（常驻进 system prompt 的那部分）───────────────────

describe('user.md 注入', () => {
  it('user.md 存在时原样读进 prompt，且带 interpolate: false', async () => {
    const { dir, config } = tempLibrary()
    const content = '称呼：某某 / 伙伴\n禁忌：不要在群里提密码。'
    fs.writeFileSync(path.join(dir, 'user.md'), content, 'utf8')

    const { ctx, sections } = makeCtx()
    mod.apply(ctx, config)
    assert.equal(sections.length, 1, '只注册一个 section')
    assert.equal(sections[0].interpolate, false, '必须是 false，否则 {{}} 会炸掉整个 prompt 组装')
    assert.equal(sections[0].text(), content.trim(), '内容应原样返回（低频变化，每次组装重读文件）')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('含 {{变量}} 与不成对花括号时也照原样返回（不插值、不抛错）', () => {
    const { dir, config } = tempLibrary()
    // 这几种写法在插值模式下会让 renderPrompt 直接 throw：
    //   {{cwd}} 未注册 → unknown prompt variable；`}}` 在前而 `{{` 在后 → malformed
    const tricky = '这里写 {{not_a_variable}} 和 {{}}，还有 5}}7 与 {{ 半拉子。'
    fs.writeFileSync(path.join(dir, 'user.md'), tricky, 'utf8')

    const { ctx, sections } = makeCtx()
    mod.apply(ctx, config)
    const text = sections[0].text()
    assert.equal(text, tricky, '自由文本必须字面保留')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('CRLF 写的 user.md 也能读（不残留 \\r）', () => {
    const { dir, config } = tempLibrary()
    fs.writeFileSync(path.join(dir, 'user.md'), '第一行\r\n第二行\r\n', 'utf8')
    const { ctx, sections } = makeCtx()
    mod.apply(ctx, config)
    const text = sections[0].text()
    assert.ok(text.includes('第一行'))
    assert.ok(text.includes('第二行'))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('空文件 / 空白文件 → 返回空串（空 section 会被丢弃，不占 token）', () => {
    const { dir, config } = tempLibrary()
    for (const body of ['', '   \n\n  ']) {
      fs.writeFileSync(path.join(dir, 'user.md'), body, 'utf8')
      const { ctx, sections } = makeCtx()
      mod.apply(ctx, config)
      assert.equal(sections[0].text(), '', `${JSON.stringify(body)} 应返回空串`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('userFile 配置可以指到库外（默认是 <库>/user.md）', () => {
    const { dir, config } = tempLibrary()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'viya-userfile-'))
    const file = path.join(outside, 'custom-user.md')
    fs.writeFileSync(file, '外部 user 文件的内容', 'utf8')

    const { ctx, sections } = makeCtx()
    mod.apply(ctx, { ...config, userFile: file })
    assert.equal(sections[0].text(), '外部 user 文件的内容')
    // 库内那个默认位置不存在时，同样返回空串
    assert.ok(!fs.existsSync(path.join(dir, 'user.md')))
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
})

// ─────────────────── 11. 图片端到端：写卡搬图 → 读卡给绝对路径 ───────────────────

describe('图片端到端', () => {
  it('写卡时搬图进 _assets，读卡时给绝对路径', async () => {
    const { dir, config } = tempLibrary()
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viya-shot-'))
    const img = path.join(srcDir, 'screenshot.png')
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const { ctx, tools } = makeCtx()
    mod.apply(ctx, config)
    const call = (name, args) => tools.get(name).execute(args, {})

    const saved = await call('memory_save', {
      title: '带图的卡',
      content: `界面长这样 ![截图](${img}) 就完事了。`,
      kind: 'knowledge',
    })
    assert.ok(saved.action.includes('搬了 1 张图'), `应报告搬图，实际：${saved.action}`)

    const cardDir = path.dirname(saved.path)
    const cardSlug = path.basename(saved.path, '.md')
    const assetPath = path.join(dir, '_assets', cardSlug, 'screenshot.png')
    assert.ok(fs.existsSync(assetPath), '图片文件应复制进库内 _assets/')

    const raw = fs.readFileSync(saved.path, 'utf8')
    assert.ok(raw.includes(`_assets/${cardSlug}/screenshot.png`), '正文里的引用应改写成库内路径')
    assert.ok(!raw.includes(img), '不应再留原始绝对路径')

    const read = await call('memory_read', { title: '带图的卡' })
    assert.equal(read.found, true)
    assert.equal(read.attachments.length, 1, `应给出 1 个附件绝对路径，实际 ${JSON.stringify(read.attachments)}`)
    assert.ok(fs.existsSync(read.attachments[0]), `附件路径必须真实存在：${read.attachments[0]}`)
    assert.equal(path.resolve(read.attachments[0]), path.resolve(assetPath))
    // 卡片目录本身不该出现图片（避免 Obsidian 图谱被图片条目搞花）
    assert.equal(fs.readdirSync(cardDir).filter(f => !f.endsWith('.md')).length, 0, '卡片目录里只应有 .md')

    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(srcDir, { recursive: true, force: true })
  })

  it('有图的卡在搜索摘要里带 📎 标记', async () => {
    const { dir, config } = tempLibrary()
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viya-shot2-'))
    const img = path.join(srcDir, 'p.png')
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const { ctx, tools } = makeCtx()
    mod.apply(ctx, config)
    const call = (name, args) => tools.get(name).execute(args, {})

    await call('memory_save', { title: '图卡甲', content: `看图 ![x](${img}) 结束。` })
    await call('memory_save', { title: '纯文字卡', content: '没有任何图片的一张卡，内容独立。' })

    const found = await call('memory_search', { query: '*' })
    const withImg = found.results.find(r => r.title === '图卡甲')
    const without = found.results.find(r => r.title === '纯文字卡')
    assert.equal(withImg.hasImage, true)
    assert.equal(without.hasImage, false)

    const rendered = tools.get('memory_search').output.render({}, found)
    assert.ok(rendered[0].text.includes('📎'), '渲染文本里要有 📎 标记')

    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(srcDir, { recursive: true, force: true })
  })
})
