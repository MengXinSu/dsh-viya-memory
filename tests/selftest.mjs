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
  return { dir, config: { library: dir, softLimit: 1000, hardLimit: 4000, searchBudget: 2000, sensitiveScan: true } }
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
    assert.equal(cfg.softLimit, 1000)
    assert.equal(cfg.hardLimit, 4000)
    // 比较语义必须成立（盒子做 > 比较永远是 false）
    assert.ok(cfg.hardLimit > cfg.softLimit, '硬限必须真的大于软限')
    assert.ok(cfg.sensitiveScan === true)
    // 普通值照样原样通过
    const plain = mod.__internals.unwrapConfig({ library: 'C:\\x', hardLimit: 4000, sensitiveScan: false })
    assert.equal(plain.library, 'C:\\x')
    assert.equal(plain.hardLimit, 4000)
    assert.equal(plain.sensitiveScan, false)
  })

  // 默认值本身也要测：上面每条断言都显式传了 hardLimit，默认值写错时
  // 那 78 条会全绿——正是最该防的静默失效。这里只给 library，其余字段吃默认。
  it('默认值：hardLimit 是 4000，软限/硬限关系成立，源码不残留旧值', () => {
    const byDefault = mod.__internals.unwrapConfig(mod.Config({ library: 'C:\\default-vault' }))
    assert.equal(byDefault.hardLimit, 4000, 'hardLimit 默认值必须是 4000')
    assert.equal(byDefault.softLimit, 1000, 'softLimit 默认值必须是 1000')
    assert.ok(byDefault.hardLimit > byDefault.softLimit, '默认值也必须满足硬限 > 软限')
    const srcText = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    assert.ok(/\.default\(4000\)/.test(srcText),
      '源码 schema 里找不到 .default(4000)——默认值被改坏了')
    // 源码里不该再有旧数值；改上限时，这条会连同断言一起报错提醒（而不是静默放行）
    const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    assert.ok(!/default\(400\)/.test(src), '源码里还有 default(400)——软限改回旧值了？')
    assert.ok(!/≤ 400 字/.test(src), '工具描述里还有「≤ 400 字」旧文案')
    const self = fs.readFileSync(new URL('./selftest.mjs', import.meta.url), 'utf8')
    assert.ok(!/'字'\.repeat\(801\)/.test(self), '自测里还有 801 的旧边界用例——它测的是空气')
  })

  // 渲染层单独测：今天那个 bug（括号嵌套 + 字数重复）就藏在 render 里，
  // 而 81 条测试全在测业务逻辑，没一条碰过 render 输出。
  it('memory_save 的 render：action 用分隔符拼接，不嵌套括号、不重复字数', async () => {
    const tools = new Map()
    const fakeCtx = {
      tools: { register: (def) => tools.set(def.name, def) },
      systemPrompt: { section: (x) => x },
      effect: () => {}, on: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    mod.apply(fakeCtx, { library: 'C:\\nope', softLimit: 1000, hardLimit: 4000 })
    const save = tools.get('memory_save')
    const plain = save.output.render({}, { title: 'T', path: 'C:\\x\\T.md', words: 300, action: '新建' })[0].text
    assert.ok(plain.includes('正文 300 字 · 新建'), '普通写入应当是「字数 · 动作」：' + plain)
    assert.ok(!plain.includes('（新建）'), '不该把 action 包进括号（历史 bug：括号嵌套不闭合）')
    const warned = save.output.render({}, {
      title: 'T2', path: 'C:\\x\\T2.md', words: 1484,
      action: '新建\n（正文 1484 字，超过软限 1000——偏长了，建议精简）',
    })[0].text
    assert.ok(warned.includes('超过软限'), '软限提示必须能渲染出来')
    assert.ok((warned.match(/正文 1484 字/g) || []).length === 2,
      '字数在外层和软限提示里各出现一次是已知的轻微重复，若结构变了请更新本测试')
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
      () => call('memory_save', { title: '并发写冲突', content: '长'.repeat(3990) + '补充新内容完全不同' }),
      /硬限/,
    )
  })

  it('memory_save 超硬限的新卡 → 报错并提示写文件', async () => {
    await assert.rejects(
      () => call('memory_save', { title: '一张超长的卡', content: '字'.repeat(4001) }),
      /硬限/,
    )
  })

  it('memory_save 超过软限 → 返回提示但仍写入（只提示不拦）', async () => {
    const r = await call('memory_save', { title: '软限提示卡', content: '字'.repeat(1001) })
    assert.ok(r.action.includes('软限'), 'action 里必须有软限提示，实际：' + r.action)
    assert.ok(r.words === 1001, '正文应当真的写进去了（软限只提示不拦）')
  })

  it('memory_update 更新后超硬限 → 报错', async () => {
    await call('memory_save', { title: '待更新的卡', content: '起' })
    await assert.rejects(
      () => call('memory_update', { title: '待更新的卡', content: '字'.repeat(4001) }),
      /硬限/,
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

  it('memory_search limit：不传默认 10、无上限、下限 1；被截断时如实报告总数', async () => {
    // 本套件此刻库里只有 8 张卡。铺到 >21 张：一是让默认值有区分力（旧的 5 与新的 10 必须能判开），
    // 二是必须**越过旧的 20 条上限**——否则把上限加回去这条测试也照样绿（实测：12 张时抓不住）。
    for (let i = 1; i <= 25; i++) {
      await call('memory_save', { title: `limit 铺底卡 ${i}`, content: `第 ${i} 张铺底卡，内容互不相同。` })
    }
    const all = await call('memory_search', { query: '*', limit: 9999 })
    const total = all.returned
    assert.ok(total >= 25, `铺底卡不足，无法验证「无上限」，实际总数 ${total}`)
    assert.ok(total > 20, `必须越过旧的 20 条上限，实际总数 ${total}`)
    assert.equal(all.total, total, '未截断时 total 应等于 returned')

    const byDefault = await call('memory_search', { query: '*' })
    assert.equal(byDefault.returned, 10, '不传 limit 时默认必须返回 10 条')
    assert.equal(byDefault.results.length, 10)
    assert.equal(byDefault.total, total, 'total 应报告真实命中总数，不受 limit 影响')

    const big = await call('memory_search', { query: '*', limit: total + 50 })
    assert.equal(big.returned, total, 'limit 大于库内总数时应返回全部（旧的上限 20 会在这里截断）')
    assert.equal(big.total, total, 'total 应报告真实命中总数')

    assert.equal((await call('memory_search', { query: '*', limit: 0 })).returned, 1, 'limit 0 归 1，不是空结果')
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
    assert.equal(typeof r.externalLinks, 'number', '库外链接计数必须存在')
  })

  // 2026-09-28 实测事故：卡里指向知识库（库外）的链接被报成死链——
  // 而 Obsidian 是整库解析的，同一份链接在那边是绿的。两个工具给相反结论，会让人白排查。
  it('memory_stats 不把「指向库外的链接」误报成死链，库内错链照报', async () => {
    await call('memory_save', {
      title: '带库外链接的卡',
      content: '见 [[技术/2026-09-28-viya-memory-改造与踩坑交接]]，以及 [[02-Projects/库里根本没有这张卡]]。',
      kind: 'mistakes',
    })
    const r = await call('memory_stats', {})
    assert.equal(r.externalLinks, 1, `库外那 1 条应单独计数，实际 ${r.externalLinks}`)
    assert.ok(!r.deadLinks.some(l => l.includes('技术/')), `库外链接不许进死链，实际：${JSON.stringify(r.deadLinks)}`)
    assert.ok(r.deadLinks.some(l => l.includes('02-Projects/库里根本没有这张卡')),
      `库内目录前缀 + 卡不存在 = 真死链，必须照报，实际：${JSON.stringify(r.deadLinks)}`)

    // 反面：不带路径的纯标题写错 → 依旧是真死链（不能被「库外」这条豁免吃掉）
    await call('memory_save', { title: '带纯标题错链的卡', content: '指向 [[库里压根没这个标题]]，应判死链。', kind: 'mistakes' })
    const r2 = await call('memory_stats', {})
    assert.ok(r2.deadLinks.some(l => l.includes('库里压根没这个标题')), '纯标题错链必须继续报死链')
    assert.equal(r2.externalLinks, 1, '纯标题错链不该被算成库外链接')
  })

  // 2026-09-28 真实库实测撞出的第二种误报：链接按**文件名**写（标题里有空格，文件名是连字符），
  // 而匹配集合当时只装标题 → 明明在库里的卡被判成死链。Obsidian 按文件名解析，它那边是绿的。
  it('memory_stats：按文件名写的库内链接不算死链（标题与文件名不一致）', async () => {
    await call('memory_save', { title: '标题里有 空格 的卡', content: '正文内容与其它卡都不同，用于文件名解析测试。', kind: 'mistakes' })
    const file = fs.readdirSync(path.join(lib.dir, '08-Mistakes')).find(f => f.startsWith('标题里有'))
    assert.ok(file, '前提：铺底卡应已落盘')
    const base = path.basename(file, '.md')
    assert.notEqual(base, '标题里有 空格 的卡', '前提：文件名必须与标题真的不同，否则这条测试没有区分力')

    await call('memory_save', { title: '按文件名引用的卡', content: `指向 [[08-Mistakes/${base}]]，不该被判成断链。`, kind: 'mistakes' })
    const r = await call('memory_stats', {})
    assert.ok(!r.deadLinks.some(l => l.includes(base)),
      `按文件名写的库内链接不许判死链，实际：${JSON.stringify(r.deadLinks)}`)
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
    // 搜被删卡的**标题**，不是「死链」这种通用词——用通用词会让这条测试
    // 悄悄依赖「全库只有那一张卡含该词」，任何新卡带这个词就假失败（2026-09-28 被咬过一次）。
    const r = await call('memory_search', { query: '带死链的卡' })
    assert.equal(r.returned, 0, '软删的卡不该再被检索到')
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
    mod.apply(ctx, { library: REAL_LIB, hardLimit: 4000, searchBudget: 2000, sensitiveScan: true })
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

// ─────────────────── 渲染层分支覆盖 ───────────────────
//
// 2026-09-28 变异扫描发现：把 render 里**各个分支的条件改成恒假**，85 条测试照样全绿——
// 也就是说 render 的多数分支从来没被任何断言碰过（历史上那个「括号嵌套 + 字数重复」的
// bug 正是藏在 render 里）。这里逐分支钉死：每条断言对应 render 里的一个分支。
describe('渲染层分支覆盖（变异扫描补）', () => {
  let tools

  before(() => {
    const made = makeCtx()
    tools = made.tools
    mod.apply(made.ctx, { library: 'C:\\nope' })
  })

  const render = (name, value) => tools.get(name).output.render({}, value).map(b => b.text).join('\n')

  it('memory_search：空结果说「没找到」，不吐命中标题行', () => {
    const out = render('memory_search', { total: 0, returned: 0, degraded: 0, results: [] })
    assert.ok(out.includes('没找到匹配的记忆卡'), `空结果必须有这句，实际：${out}`)
    assert.ok(!out.includes('命中'), '空结果不该出现「命中 N 张」')
  })

  it('memory_search：命中时逐条给出标题 / kind / 路径 / 摘要 / 附图标记', () => {
    const out = render('memory_search', {
      total: 7,
      returned: 1,
      degraded: 0,
      results: [{
        title: '卡片标题', path: 'C:\\lib\\x.md', kind: '03-Knowledge',
        updated: '2026-09-28', summary: '摘要文字', hasImage: true, score: 3,
      }],
    })
    assert.ok(out.includes('命中 7 张，返回 1 张'), `命中行要报总数与返回数，实际：${out}`)
    for (const piece of ['卡片标题', '03-Knowledge', 'C:\\lib\\x.md', '摘要文字', '📎']) {
      assert.ok(out.includes(piece), `缺 ${piece}，实际：${out}`)
    }
  })

  it('memory_search：有降级条目时必须如实说降级了几条', () => {
    const out = render('memory_search', {
      total: 3,
      returned: 1,
      degraded: 2,
      results: [{
        title: 't', path: 'p', kind: 'k', updated: 'd', summary: 's', hasImage: false, score: 1,
      }],
    })
    assert.ok(out.includes('2 条因预算不足降级'), `降级要报告，实际：${out}`)
  })

  it('memory_read：found=false 说「记忆不存在」，并带上要找的名字', () => {
    const out = render('memory_read', {
      found: false, title: '没有的卡', path: '', status: '', updated: '', links: [], attachments: [], body: '',
    })
    assert.ok(out.includes('记忆不存在'), `实际：${out}`)
    assert.ok(out.includes('没有的卡'), '要带上要找的名字，否则不知道哪张没找到')
  })

  it('memory_read：元信息 / links / attachments / 正文 / 收尾标签，五段缺一不可', () => {
    const out = render('memory_read', {
      found: true, title: 'T', path: 'P', status: 'approved', updated: '2026-09-28',
      links: ['A --related--> B'], attachments: ['E:\\x\\y.png'], body: '正文内容',
    })
    assert.ok(out.startsWith('<card path="P">'), `要以 card 标签开头，实际：${out}`)
    assert.ok(out.includes('title: T'), '缺 title 行')
    assert.ok(out.includes('status: approved'), '缺 status 行')
    assert.ok(out.includes('updated: 2026-09-28'), '缺 updated 行')
    assert.ok(out.includes('links: A --related--> B'), '有链接必须列出来')
    assert.ok(out.includes('attachments: E:\\x\\y.png'), '有附件必须列出来')
    assert.ok(out.includes('正文内容'), '正文必须原样在')
    assert.ok(out.trimEnd().endsWith('</card>'), '缺收尾标签')
  })

  it('memory_update：无字段变更时说「（无）」，有变更时逐项列出', () => {
    const none = render('memory_update', { title: 'T', path: 'P', words: 12, changed: [] })
    assert.ok(none.includes('改了：（无）'), `实际：${none}`)
    const some = render('memory_update', { title: 'T', path: 'P', words: 12, changed: ['tags', 'importance'] })
    assert.ok(some.includes('改了：tags、importance'), `实际：${some}`)
  })

  it('memory_link：created / updated / skipped 三种回执互不相同', () => {
    const base = { source: 'A', target: 'B', type: 'related' }
    assert.ok(render('memory_link', { ...base, status: 'created' }).includes('已连边'), 'created 回执不对')
    assert.ok(render('memory_link', { ...base, status: 'updated' }).includes('已更新边'), 'updated 回执不对')
    assert.ok(render('memory_link', { ...base, status: 'skipped' }).includes('跳过'), 'skipped 回执不对')
  })

  it('memory_forget：四态回执（preview / deleted / not-found / trashed）', () => {
    const base = { title: 'T', path: 'P', links: 2, referrers: 3 }
    const preview = render('memory_forget', { ...base, mode: 'preview' })
    assert.ok(preview.includes('什么都没动'), `preview 必须强调没动，实际：${preview}`)
    assert.ok(preview.includes('confirm'), 'preview 要告诉怎么确认')
    assert.ok(preview.includes('2 条关系') && preview.includes('3 张卡'), 'preview 要报清引用面')
    assert.ok(render('memory_forget', { ...base, mode: 'deleted' }).includes('已永久删除'), 'deleted 回执不对')
    assert.ok(render('memory_forget', { ...base, mode: 'not-found' }).includes('没动任何东西'), 'not-found 回执不对')
    const trashed = render('memory_forget', { ...base, mode: 'trashed' })
    assert.ok(trashed.includes('已忘掉') && trashed.includes('回收站'), `trashed 回执不对：${trashed}`)
  })

  it('memory_stats：分布 / 超长卡 / 死链 / 库外链接 四段都在，且 0 条库外链接时不刷屏', () => {
    const out = render('memory_stats', {
      total: 5, trashed: 1,
      oversized: ['超长卡（5000 字）'],
      deadLinks: ['A → [[没有的卡]]'],
      externalLinks: 3,
      kinds: [{ dir: '03-Knowledge', count: 5 }],
    })
    assert.ok(out.includes('各目录分布'), `缺分布段，实际：${out}`)
    assert.ok(out.includes('03-Knowledge: 5 张'), `分布行不对：${out}`)
    assert.ok(out.includes('超长卡（5000 字）'), '缺超长卡条目')
    assert.ok(out.includes('A → [[没有的卡]]'), '缺死链条目')
    assert.ok(out.includes('库外链接：3 条'), '缺库外链接计数')

    const zero = render('memory_stats', {
      total: 1, trashed: 0, oversized: [], deadLinks: [], externalLinks: 0, kinds: [],
    })
    assert.ok(!zero.includes('库外链接'), `0 条时不该出现这一行，实际：${zero}`)
  })
})

// ─────────────────── 变异扫描补测（2026-09-28） ───────────────────
//
// 每一条都对应一个「人为造出缺陷、85 条测试却全绿」的变异点。
// 判定过：这些是**真盲区**（另外两类漏点已排除——等价变异如冗余防御、纯文案）。
describe('变异扫描补测：真盲区回填（2026-09-28）', () => {
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

  // 变异点：删掉 differing() 里的 `return Number(old.weight) !== next.weight || ...`
  // → 函数变 undefined（falsy）→「同类型边、只改 weight」会被误判成 already-linked，改动静默丢失。
  it('memory_link 同类型改 weight：返回 updated，且新权重真的落盘', async () => {
    await call('memory_save', { title: '连边甲', content: '甲卡正文，内容独立。', kind: 'mistakes' })
    await call('memory_save', { title: '连边乙', content: '乙卡正文，内容独立。', kind: 'mistakes' })

    const first = await call('memory_link', { source: '连边甲', target: '连边乙', type: 'related', weight: 0.5 })
    assert.equal(first.status, 'created')

    const again = await call('memory_link', { source: '连边甲', target: '连边乙', type: 'related', weight: 0.9 })
    assert.equal(again.status, 'updated', '同类型但权重变了，必须是 updated，不是 already-linked')

    const raw = fs.readFileSync(path.join(lib.dir, '08-Mistakes', '连边甲.md'), 'utf8')
    assert.ok(raw.includes('weight: 0.9'), `新权重必须落盘，实际：${raw}`)
  })

  it('memory_link 连同样的边 → already-linked（不重复写）', async () => {
    const r = await call('memory_link', { source: '连边甲', target: '连边乙', type: 'related', weight: 0.9 })
    assert.equal(r.status, 'already-linked')
  })

  // 变异点：`hasOwn(args,'weight') && Number.isFinite(...)` 的 && 改成 ||。
  // 判定结果：**等价变异**——非数字的 weight 在 defineTool 的参数 schema 那一层就被拒了
  // （实测 `weight: 'abc'` 直接 ToolArgsError），Number.isFinite 只是第二道防线，够不到。
  // 真正有语义的是 hasOwn 那一半，所以这里测「没说就不该动已有边」。
  it('memory_link 不传 weight → 已有边的权重不被改写', async () => {
    const r = await call('memory_link', { source: '连边甲', target: '连边乙', type: 'related' })
    assert.equal(r.status, 'already-linked', '没说就是没说，不该动已有边')
    const raw = fs.readFileSync(path.join(lib.dir, '08-Mistakes', '连边甲.md'), 'utf8')
    assert.ok(raw.includes('weight: 0.9'), `权重必须还是 0.9，实际：${raw}`)
  })

  // 变异点：`other.links.some(l => l.target === card.title)` 的 === 改成 !==
  // → 引用计数算错（会去数「引用了任何别的东西」的卡）。
  //
  // 这条**必须用独立的最小库**：第一版写在共享库里，而库里恰好有两张互相引用的卡
  // （连边甲/乙），变异后的错误实现数出来正好也是 2 —— 期望值与错误结果撞在一起，
  // 测试全绿、缺陷溜过。（变异验证里最阴的一种假绿：不是没覆盖，是期望值凑巧相等。）
  // 现在独立成库，再放一张「谁都不引用」的路人卡当干扰项。
  it('memory_forget 预览里「有几张卡引用了它」必须数准', async () => {
    const solo = tempLibrary()
    const made = makeCtx()
    mod.apply(made.ctx, solo.config)
    const soloCall = (name, args) => made.tools.get(name).execute(args, {})

    try {
      await soloCall('memory_save', { title: '被引用卡', content: '这张卡会被别人引用。', kind: 'mistakes' })
      await soloCall('memory_save', { title: '引用者甲', content: '见 [[被引用卡]]，甲自己的内容。', kind: 'mistakes' })
      await soloCall('memory_save', { title: '引用者乙', content: '也见 [[被引用卡]]，乙自己的内容。', kind: 'mistakes' })
      await soloCall('memory_save', { title: '路人卡', content: '这张卡谁也没引用，也没有引用谁。', kind: 'mistakes' })

      const p = await soloCall('memory_forget', { title: '被引用卡' })
      assert.equal(p.mode, 'preview')
      assert.equal(p.referrers, 2, `只有甲和乙引用它，实际 ${p.referrers}`)
      assert.equal(p.links, 0, '它自己没引用别人')
    } finally {
      fs.rmSync(solo.dir, { recursive: true, force: true })
    }
  })

  // 变异点：`if (wanted.length === 0)` 恒假 → 空 title 不再报错，转而去搜一个空名字。
  it('memory_forget 空 title → 明确报错，不做任何事', async () => {
    await assert.rejects(() => call('memory_forget', { title: '   ' }), /title 不能为空/)
  })

  // 变异点：`if (fs.existsSync(dest))` 恒假 → 回收站里已有同名文件时**直接覆盖**
  // （后删的那份吃掉先删的，是静默数据丢失）。
  it('memory_forget 回收站里撞名 → 另存一份，绝不覆盖已有文件', async () => {
    await call('memory_save', { title: '撞名卡', content: '正式内容，独立。', kind: 'mistakes' })

    // 预置一个同名文件在回收站里，模拟「历史上删过的同名卡」
    const trash = path.join(lib.dir, '_trashed')
    fs.mkdirSync(trash, { recursive: true })
    const squatter = path.join(trash, '撞名卡.md')
    const squatterBody = '---\ntitle: 撞名卡\nstatus: deleted\n---\n\n更早删掉的那一份，不能被覆盖。\n'
    fs.writeFileSync(squatter, squatterBody, 'utf8')

    const r = await call('memory_forget', { title: '撞名卡', confirm: true })
    assert.equal(r.mode, 'trashed')
    assert.ok(fs.existsSync(r.path), '新删的这份要落盘')
    assert.notEqual(r.path, squatter, '撞名时必须另存一个名字，而不是覆盖')
    assert.equal(fs.readFileSync(squatter, 'utf8'), squatterBody, '回收站里原有的那份必须一字不动')
  })

  // 变异点：memory_update 里的 `if (cfg.sensitiveScan !== false)` 恒假
  // → update 这条路径的敏感信息闸被整个旁路。
  // 原来只有 memory_save 测过敏感扫描——同一个闸的另一扇门（update）从没验证过。
  it('memory_update 也要拦敏感信息（同一个闸的另一扇门）', async () => {
    await call('memory_save', { title: '待脱敏的卡', content: '正常内容，稍后会用 update 往里塞密钥。', kind: 'mistakes' })

    await assert.rejects(
      () => call('memory_update', { title: '待脱敏的卡', content: 'key = sk-abcdefghijklmnopqrstuvwx' }),
      /敏感信息/,
    )
    const raw = fs.readFileSync(path.join(lib.dir, '08-Mistakes', '待脱敏的卡.md'), 'utf8')
    assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwx'), '拒绝之后盘上不能留下这串密钥')
    assert.ok(raw.includes('正常内容'), '被拒的那次不能把原正文弄丢')
  })

  // 变异点：`if (words > hardLimit)` 恒假 → 体检不再报告超长卡。
  // 长度闸在写入侧挡住了超长卡，所以这里直接落盘一张，专门喂给体检。
  it('memory_stats 要报告超长卡（> 硬限）', async () => {
    await call('memory_save', { title: '正常卡', content: '正常长度的内容。' }) // 默认落 03-Knowledge，顺带把目录建出来
    const file = path.join(lib.dir, '03-Knowledge', '手写的超长卡.md')
    fs.writeFileSync(file, `---\nformatVersion: 1\ntitle: 手写的超长卡\nkind: 03-Knowledge\n---\n\n${'字'.repeat(4200)}\n`, 'utf8')

    const r = await call('memory_stats', {})
    assert.ok(r.oversized.some(o => o.includes('手写的超长卡')), `超长卡必须被报出来，实际：${JSON.stringify(r.oversized)}`)
    assert.ok(r.oversized.some(o => o.includes('4200')), '要带上实际字数')

    fs.rmSync(file, { force: true })
  })
})

// 2026-09-28 审查复现：回收站与保留目录必须和卡目录隔离（B5 / B7 / B12）。
// 每条用独立最小库，避免共享库里的其它卡让断言碰巧成立。
describe('审查修复①：回收站与保留目录隔离', () => {
  const fresh = () => {
    const lib = tempLibrary()
    const made = makeCtx()
    mod.apply(made.ctx, lib.config)
    return { lib, call: (name, args) => made.tools.get(name).execute(args, {}) }
  }

  it('kind 模糊匹配不会命中 _trashed / _assets（B5）', async () => {
    const { lib, call } = fresh()
    try {
      fs.mkdirSync(path.join(lib.dir, '_trashed'), { recursive: true })
      fs.mkdirSync(path.join(lib.dir, '_assets'), { recursive: true })
      const r1 = await call('memory_save', { title: '垃圾卡', content: '内容一，独立。', kind: 'trash' })
      const r2 = await call('memory_save', { title: '资产卡', content: '内容二，独立。', kind: 'assets' })
      const head = p => path.relative(lib.dir, p).split(/[\\/]/)[0]
      assert.ok(!head(r1.path).startsWith('_'), `不能写进保留目录，实际 ${r1.path}`)
      assert.ok(!head(r2.path).startsWith('_'), `不能写进保留目录，实际 ${r2.path}`)
      assert.equal((await call('memory_search', { query: '垃圾卡' })).total, 1, '写进去的卡必须搜得到')
      assert.equal((await call('memory_search', { query: '资产卡' })).total, 1, '写进去的卡必须搜得到')
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('ensureDirs 的 kind 候选不含 _ / . 前缀目录', () => {
    const lib = tempLibrary()
    try {
      for (const d of ['_trashed', '_assets', '.git', '.obsidian', '09-Custom']) {
        fs.mkdirSync(path.join(lib.dir, d), { recursive: true })
      }
      const { kinds } = I.ensureDirs(lib.config)
      for (const d of ['_trashed', '_assets', '.git', '.obsidian']) assert.ok(!kinds.has(d), `${d} 不该是 kind`)
      assert.ok(kinds.has('09-Custom'), '普通自建目录仍是 kind')
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('save 撞上 status: deleted 的同名卡 → 报错，不往黑洞里追加（B7）', async () => {
    const { lib, call } = fresh()
    try {
      const r = await call('memory_save', { title: 'D卡', content: '原始内容甲乙丙丁戊。' })
      await call('memory_update', { title: 'D卡', status: 'deleted' })
      const before = fs.readFileSync(r.path, 'utf8')
      await assert.rejects(
        () => call('memory_save', { title: 'D卡', content: '新的重要结论子丑寅卯辰。' }),
        /deleted/,
      )
      assert.equal(fs.readFileSync(r.path, 'utf8'), before, '被拒时盘上一字不动')
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('save 与回收站里的卡同名 → 在正常目录新建，不碰回收站那份（B7）', async () => {
    const { lib, call } = fresh()
    try {
      await call('memory_save', { title: 'T卡', content: '旧版内容甲乙丙。' })
      const gone = await call('memory_forget', { title: 'T卡', confirm: true })
      const trashedBefore = fs.readFileSync(gone.path, 'utf8')
      const r = await call('memory_save', { title: 'T卡', content: '全新内容子丑寅卯。' })
      assert.equal(r.action.startsWith('新建'), true, `应新建，实际 ${r.action}`)
      assert.ok(!r.path.includes('_trashed'), `不能写进回收站，实际 ${r.path}`)
      assert.equal(fs.readFileSync(gone.path, 'utf8'), trashedBefore, '回收站那份一字不动')
      assert.equal((await call('memory_search', { query: '子丑寅卯' })).total, 1)
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('update / link / 软删 摸不到回收站里的卡（B12）', async () => {
    const { lib, call } = fresh()
    try {
      await call('memory_save', { title: 'T1', content: '甲卡内容，独立。' })
      await call('memory_save', { title: 'T2', content: '乙卡内容，独立。' })
      const gone = await call('memory_forget', { title: 'T1', confirm: true })
      const trashedBefore = fs.readFileSync(gone.path, 'utf8')
      const t2Before = fs.readFileSync(path.join(lib.dir, '03-Knowledge', 'T2.md'), 'utf8')

      await assert.rejects(() => call('memory_update', { title: 'T1', importance: 5 }), /不存在/)
      await assert.rejects(() => call('memory_link', { source: 'T2', target: 'T1' }), /不存在/)
      // 按回收站路径直接点名也不行
      await assert.rejects(() => call('memory_update', { title: gone.path, importance: 5 }), /不存在/)
      const again = await call('memory_forget', { title: 'T1', confirm: true })
      assert.equal(again.mode, 'not-found', '已在回收站的卡不能再软删一次')

      assert.equal(fs.readFileSync(gone.path, 'utf8'), trashedBefore, '回收站那份一字不动')
      assert.equal(fs.readFileSync(path.join(lib.dir, '03-Knowledge', 'T2.md'), 'utf8'), t2Before, '不许留下单向边')
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('read 仍能看回收站；permanent 删除仍能清回收站', async () => {
    const { lib, call } = fresh()
    try {
      await call('memory_save', { title: 'R卡', content: '将被删的卡，独立内容。' })
      const gone = await call('memory_forget', { title: 'R卡', confirm: true })
      const read = await call('memory_read', { title: 'R卡' })
      assert.equal(read.found, true, 'read 要能看到回收站里的卡')
      assert.equal(read.status, 'deleted')
      const preview = await call('memory_forget', { title: 'R卡', permanent: true })
      assert.equal(preview.mode, 'preview', 'permanent 也要先预览')
      assert.ok(fs.existsSync(gone.path), '预览不动文件')
      const del = await call('memory_forget', { title: 'R卡', permanent: true, confirm: true })
      assert.equal(del.mode, 'deleted')
      assert.ok(!fs.existsSync(gone.path), '永久删除要能清掉回收站里的卡')
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })
})

// 2026-09-28 审查复现 B10：forget 预览的引用计数只认「target === 标题」，
// 按文件名 / 带目录前缀 / 带锚点写的引用全漏。独立最小库 + 干扰项，防期望值撞车。
describe('审查修复③：forget 预览引用计数口径', () => {
  it('标题 / 文件名 / 目录前缀 / 锚点 / 别名都算引用；同名不同目录与路人不算', async () => {
    const lib = tempLibrary()
    const made = makeCtx()
    mod.apply(made.ctx, lib.config)
    const call = (name, args) => made.tools.get(name).execute(args, {})
    try {
      await call('memory_save', { title: '被 引用 卡', content: '被引用的卡内容，独立。' })
      await call('memory_save', { title: '引用者一', content: '按文件名 [[被-引用-卡]]，一。' })
      await call('memory_save', { title: '引用者二', content: '带目录 [[03-Knowledge/被-引用-卡]]，二。' })
      await call('memory_save', { title: '引用者三', content: '按标题 [[被 引用 卡]]，三。' })
      await call('memory_save', { title: '引用者四', content: '带锚点别名 [[被 引用 卡#小节|看这里]]，四。' })
      await call('memory_save', { title: '干扰甲', content: '目录不对 [[08-Mistakes/被-引用-卡]]，甲。' })
      await call('memory_save', { title: '干扰乙', content: '别的卡 [[引用者一]]，乙。' })
      // 末段恰好是标题、目录却不对：必须不算（M10 变异「前缀不校验」只有这条能抓）
      await call('memory_save', { title: '干扰丙', content: '目录不对但末段是标题 [[08-Mistakes/被 引用 卡]]，丙。' })
      const p = await call('memory_forget', { title: '被 引用 卡' })
      assert.equal(p.mode, 'preview')
      assert.equal(p.referrers, 4, `应为 4（一二三四），实际 ${p.referrers}`)
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('linkPointsTo 单元：大小写不敏感、.md 后缀、反斜杠', () => {
    const card = { title: 'Foo Bar', path: path.join('X', '03-Knowledge', 'Foo-Bar.md') }
    assert.equal(I.linkPointsTo('foo bar', card), true)
    assert.equal(I.linkPointsTo('Foo-Bar.md', card), true)
    assert.equal(I.linkPointsTo('03-Knowledge\\Foo-Bar', card), true)
    assert.equal(I.linkPointsTo('03-Knowledge/Foo Bar', card), true)
    assert.equal(I.linkPointsTo('02-Projects/Foo-Bar', card), false)
    assert.equal(I.linkPointsTo('02-Projects/Foo Bar', card), false, '末段是标题但目录不对，不算')
    assert.equal(I.linkPointsTo('Foo', card), false)
    assert.equal(I.linkPointsTo('', card), false)
  })
})

// 2026-09-28 审查复现 B8：用户/Obsidian 插件写的未知 frontmatter 字段，任何写入都不能抹掉。
describe('审查修复②：未知 frontmatter 字段原样保留', () => {
  const fresh = () => {
    const lib = tempLibrary()
    const made = makeCtx()
    mod.apply(made.ctx, lib.config)
    return { lib, call: (name, args) => made.tools.get(name).execute(args, {}) }
  }
  // 行内 + 块式 + 嵌套缩进三种写法都要活下来
  const EXTRA = 'aliases: [别名一, 别名二]\ncssclasses:\n  - wide\n  - no-title\nplugin_cfg:\n  nested: 1\n  deep: "x: y"'
  const inject = (file) => {
    const t = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, t.replace(/\n---\n/, `\n${EXTRA}\n---\n`), 'utf8')
  }
  const assertExtra = (file, when) => {
    const t = fs.readFileSync(file, 'utf8')
    const fm = t.split('\n---\n')[0]
    assert.ok(fm.includes(EXTRA), `${when} 后未知字段必须逐字保留，实际 frontmatter：\n${fm}`)
    assert.equal(fm.split('aliases:').length - 1, 1, `${when} 后 aliases 不能重复出现`)
  }

  it('update / save 追加 / link / forget 之后都保留（逐字、不重复）', async () => {
    const { lib, call } = fresh()
    try {
      const a = await call('memory_save', { title: '字段卡', content: '甲乙丙丁的原始内容。' })
      await call('memory_save', { title: '另一张', content: '子丑寅卯，独立内容。' })
      inject(a.path)

      await call('memory_update', { title: '字段卡', importance: 4 })
      assertExtra(a.path, 'update')
      await call('memory_save', { title: '字段卡', content: '完全不同的补充：戊己庚辛壬癸。' })
      assertExtra(a.path, 'save 追加')
      await call('memory_link', { source: '字段卡', target: '另一张', type: 'explains' })
      assertExtra(a.path, 'link')
      const gone = await call('memory_forget', { title: '字段卡', confirm: true })
      assertExtra(gone.path, 'forget')
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('已知字段不会被当成未知字段重复写出', () => {
    const src = '---\ntitle: T\ntags:\n  - a\nlinks:\n  - {target: X, type: related, weight: 0.7, description: \'\'}\naliases: [q]\n---\n\nbody'
    const card = I.parseCard(src, 'x/03-Knowledge/T.md')
    assert.deepEqual(card.extraFrontmatter, ['aliases: [q]'])
    const out = I.serializeCard(card)
    assert.equal(out.split('tags:').length - 1, 1, 'tags 只能出现一次')
    assert.equal(out.split('links:').length - 1, 1, 'links 只能出现一次')
    // 往返稳定：再解析一次，未知字段不变
    assert.deepEqual(I.parseCard(out, 'x/03-Knowledge/T.md').extraFrontmatter, ['aliases: [q]'])
  })
})

// 2026-09-28 审查复现 B6：memory_save 的绝对路径标题不能把卡写到库外 / 保留目录 / 子目录。
describe('审查修复④：save 只写库内一级卡目录', () => {
  const fresh = () => {
    const lib = tempLibrary()
    const made = makeCtx()
    mod.apply(made.ctx, lib.config)
    return { lib, call: (name, args) => made.tools.get(name).execute(args, {}) }
  }

  it('库外绝对路径 → 报错，库外不落文件', async () => {
    const { lib, call } = fresh()
    const outside = path.join(os.tmpdir(), `viya-outside-${process.pid}-${Date.now()}`)
    try {
      await assert.rejects(() => call('memory_save', { title: outside, content: '库外写入测试，独立。' }), /不在记忆库内/)
      assert.equal(fs.existsSync(`${outside}.md`), false, '库外绝不能出现文件')
    } finally {
      fs.rmSync(`${outside}.md`, { force: true })
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })

  it('库根 / 保留目录 / 深层子目录 → 报错且不落盘；一级卡目录绝对路径照常可写', async () => {
    const { lib, call } = fresh()
    try {
      const bad = [
        path.join(lib.dir, '根上的卡'),
        path.join(lib.dir, '_trashed', '回收站里的卡'),
        path.join(lib.dir, '.obsidian', '配置里的卡'),
        path.join(lib.dir, '03-Knowledge', 'sub', '深层卡'),
      ]
      for (const p of bad) {
        await assert.rejects(() => call('memory_save', { title: p, content: '不该落盘的内容，独立。' }), /拒绝写入/, `应拒绝：${p}`)
        assert.equal(fs.existsSync(`${p}.md`), false, `不能落盘：${p}`)
      }
      const good = path.join(lib.dir, '03-Knowledge', '绝对路径卡')
      const r = await call('memory_save', { title: good, content: '一级卡目录里的绝对路径，允许。' })
      assert.equal(r.path, `${good}.md`)
      assert.ok(fs.existsSync(r.path))
    } finally {
      fs.rmSync(lib.dir, { recursive: true, force: true })
    }
  })
})