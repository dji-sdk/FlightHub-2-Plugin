// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
'use strict'

// 三层断言设计：
// - 结构层：路由表与文件清单一致、每篇有可判定出口条件、相对链接有效
// - 事实层：命令顺序、路径、禁止项（内部路由 / 完整 Contract / link:toolchain）——回归网
// - 语义锚点层：少量关键政策句的语义共现检查（措辞可自由改写，语义必须保留）
//
// 措辞断言只锚「语义必然出现的词」，不锁整句。改文案时先问：这条断言保护的是哪个平台事实？

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const skillRoot = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(skillRoot, file), 'utf8')
const references = fs.readdirSync(path.join(skillRoot, 'references')).filter(file => file.endsWith('.md')).sort()
const skill = read('SKILL.md')
const consumerDocs = () => ['SKILL.md', 'README.md', ...references.map(file => `references/${file}`)]

// 正文行：排除 frontmatter、围栏代码块与表格行；用于可读性门禁。
// frontmatter 的 description 必须是单行，不属于散文行。
function proseLines (content) {
  const lines = content.split('\n')
  const start = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0
  const prose = []
  let inFence = false
  for (const line of lines.slice(start)) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || line.trim() === '' || line.trim().startsWith('|')) continue
    prose.push(line)
  }
  return prose
}

test('消费 Skill 全部 references 路由与文件一致，每篇有可判定出口条件', () => {
  const table = skill.split('## references 路由表')[1]
  assert.ok(table)
  const routes = [...table.matchAll(/\| `references\/([^`]+)` \|/g)].map(match => match[1]).sort()
  assert.deepEqual(routes, references)
  for (const reference of references) {
    const content = read(`references/${reference}`)
    assert.match(content, /## 出口条件\s+[\s\S]*- \[ \]/)
  }
  for (const file of ['SKILL.md', 'README.md', ...references.map(file => `references/${file}`)]) {
    for (const match of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (/^[a-z]+:\/\//i.test(target) || target.startsWith('#')) continue
      assert.ok(fs.existsSync(path.resolve(skillRoot, path.dirname(file), target.split('#')[0])), `${file}: ${target}`)
    }
  }
})

test('全部消费文档只有 SOURCE 获取，不引导内部路由或安装完整 Contract', () => {
  for (const file of consumerDocs()) {
    const content = read(file)
    assert.doesNotMatch(content, /nexus|djicorp|AD 凭据|--probe-network|install_contract|platform-contract\//i, file)
    assert.doesNotMatch(content, /(?:npm|pnpm|yarn)\s+(?:exec|add|install|i|dlx|login|view)[^\n]*@4f2e/i, file)
    assert.doesNotMatch(content, /@4f2e\/fh2-plugin-contract/, file)
  }
  const bootstrap = read('references/00-environment-bootstrap.md')
  assert.match(bootstrap, /https:\/\/github\.com\/dji-sdk\/FlightHub-2-Plugin/)
  assert.match(bootstrap, /固定 tag\/commit/)
  assert.match(bootstrap, /packages\/fh2-plugin-toolchain\/bin\/fh2-plugin\.mjs/)
  assert.match(bootstrap, /--platform-root/)
})

test('SOURCE 初始化按纯源码构建执行，不强制全局注册，也不残留预构建路线', () => {
  const bootstrap = read('references/00-environment-bootstrap.md')
  const source = bootstrap.split('### 纯源码初始化')[1].split('### 可选全局注册')[0]
  const commands = content => [...content.matchAll(/```sh\s*([\s\S]*?)```/g)].map(match => match[1])
  const sourceCommands = commands(source).join('\n')
  assert.ok(sourceCommands.indexOf('pnpm install --frozen-lockfile') < sourceCommands.indexOf('pnpm build:tooling'))
  assert.ok(sourceCommands.indexOf('pnpm build:tooling') < sourceCommands.indexOf('fh2-plugin.mjs" --help'))
  assert.doesNotMatch(sourceCommands, /link:toolchain|link\.mjs/)
  assert.match(source, /不要求补入私有 Contract、Engine 或宿主源码/)
  assert.match(bootstrap, /纯源码.*交付[\s\S]*不以有无 `dist\/` 猜路线/)
  assert.match(bootstrap, /### 可选全局注册[\s\S]*node scripts\/public-source\/link\.mjs[\s\S]*只注册已有构建[\s\S]*未选择注册不算初始化缺项/)
  assert.match(bootstrap, /移动\/升级前[\s\S]*发行路线[\s\S]*纯源码构建路线[\s\S]*显式重装、生成、验证/)
  for (const file of ['SKILL.md', 'README.md', 'references/05-validation-debug.md']) {
    const content = read(file)
    assert.match(content, /纯源码/, file)
    assert.match(content, /build:tooling/, file)
    assert.match(content, /不自动降级|不静默跳过|不静默输出|不要求完整 Contract/, file)
    assert.doesNotMatch(commands(content).join('\n'), /pnpm link:toolchain/, file)
  }
  // 回归守卫：公开树已正式决策纯源码交付，消费文档不得再教预构建路线。
  // 00 的路线宣告段（「当前发行按纯源码交付……不含预构建产物」）是唯一允许出现该词的位置。
  const bootstrapDeclaration = '当前发行按**纯源码**交付'
  const bootstrapBody = read('references/00-environment-bootstrap.md').split(bootstrapDeclaration)[0] + bootstrapDeclaration
  for (const [file, content] of [
    ['SKILL.md', read('SKILL.md')],
    ['README.md', read('README.md')],
    ...references.map(file => [`references/${file}`, read(`references/${file}`)]),
  ]) {
    const scope = file === 'references/00-environment-bootstrap.md' ? bootstrapBody : content
    assert.doesNotMatch(scope, /预构建|prebuilt|check-prebuilt\.mjs/, file)
  }
  assert.doesNotMatch(read('scripts/resolve-env.cjs'), /check-prebuilt\.mjs|prebuilt-manifest\.json/)
})

test('显式 SOURCE 探针文档保持本地优先、损坏阻断与只读边界', () => {
  const bootstrap = read('references/00-environment-bootstrap.md')
  for (const file of ['SKILL.md', 'README.md', 'references/00-environment-bootstrap.md']) {
    assert.match(read(file), /--platform-root/, file)
  }
  assert.match(bootstrap, /工程及祖先的本地包 → 显式 `--platform-root` 指定的开发者工具 → PATH\/全局/)
  assert.match(bootstrap, /相对路径按调用 cwd 解析/)
  assert.match(bootstrap, /省略时保留原本地\/PATH\/全局发现行为/)
  assert.match(bootstrap, /根 `package\.json` 身份 `fh2-plugin-platform`[\s\S]*包名错误或[^。\n]*损坏[\s\S]*不回退全局版本/)
  assert.match(bootstrap, /source=linked` 表示直接源码或源码链接[\s\S]*schemaVersion: 3/)
  assert.match(bootstrap, /探针不执行交付检查器或构建/)
  assert.match(skill, /探针不访问网络、不装包、不改配置/)
})

test('manifest 最小探测与完整加载区分、逻辑 index 与两套知识数据边界说明保留', () => {
  assert.match(skill, /manifest 最小探测通过/)
  assert.match(skill, /manifest\.sourceVersions\.contract/)
  const bootstrap = read('references/00-environment-bootstrap.md')
  assert.match(bootstrap, /package\.json` 缺失、不可读或链接悬空[\s\S]*repair_toolchain/)
  assert.match(bootstrap, /bin\/fh2-plugin\.mjs[\s\S]*先证明包身份[\s\S]*不解析任意 shell wrapper/)
  assert.match(bootstrap, /PATH 未绑定具体包[\s\S]*记住首个损坏候选[\s\S]*manifest 缺失\/损坏仍阻断/)
  const planning = read('references/01-planning-spec.md')
  assert.ok(planning.includes('resources.json.files[\'index.json\']'))
  assert.match(planning, /不存在磁盘 `developer-runtime\/index\.json`/)
  assert.match(planning, /resources\.json\.facts\[ref\]/)
  assert.match(planning, /resolved=false[\s\S]*value=null[\s\S]*warning/)
  assert.match(planning, /approvedEntries[\s\S]*不当公开条目数/)
  assert.match(read('references/04-backend-guidelines.md'), /探针 contract\.path 非空不证明 DAG 知识已固定/)
})

test('安装 README 保持 fh2-plugin-dev 客户端布局，CLI 注册不冒充 Skill 安装', () => {
  const readme = read('README.md')
  assert.match(skill, /name: fh2-plugin-dev/)
  for (const target of ['skills/fh2-plugin-dev/', '.opencode/skills/fh2-plugin-dev/SKILL.md', '.config/opencode/skills/fh2-plugin-dev/SKILL.md', '.claude/skills/fh2-plugin-dev/SKILL.md', 'scripts/resolve-env.cjs']) {
    assert.ok(readme.includes(target), target)
  }
  // 语义锚点：源码 bin 可直接用 + 注册不等于安装 Skill。
  assert.match(readme, /bin 可以直接用，不要求全局注册/)
  assert.match(readme, /注册 CLI 也不会让 AI 客户端自动发现 Skill/)
  assert.match(readme, /只注册已有构建/)
  assert.match(readme, /退出并重新启动客户端/)
  assert.match(readme, /不自动覆盖/)
  assert.match(readme, /Node 20\.19/)
})

test('SOURCE 变更保留 Step 0 角色、确认、拒绝、数据保护和自己的进程清理', () => {
  const step0 = skill.split('## Step 0：')[1].split('## 全流程状态机')[0]
  for (const value of ['操作者角色', '允许读写的工程根', 'Token', 'Cookie', '私钥', '客户数据', '环境全集', '停止自己启动的进程/任务']) {
    assert.ok(step0.includes(value), value)
  }
  assert.match(skill, /无关未提交改动/)
  const bootstrap = read('references/00-environment-bootstrap.md')
  assert.match(bootstrap, /用户拒绝[\s\S]*无法继续/)
  assert.match(bootstrap, /不自动安装或反复施压/)
  const frontend = read('references/03-frontend-guidelines.md')
  assert.ok(frontend.includes('localStorage.clear()'))
  assert.ok(frontend.includes('不覆盖 View'))
  assert.ok(frontend.includes('只隔离 UI/CSS'))
  const validation = read('references/05-validation-debug.md')
  for (const value of ['taskId 只代表已接收', 'succeeded/failed/cancelled', '不等待 succeeded', '只取消自己的任务', '用完停止自己的 preview', '恢复本次 PAC/代理设置', 'import/use 或知识锁升级', '显式同意', 'DAG 预检非执行', 'IDE_SAVE_DETACHED_SCRIPT', 'IDE_SAVE_NEW_FILE_STATE', 'IDE_SAVE_TASK_BARRIER', 'IDE_SAVE_SKIPPED_RECEIPT']) {
    assert.ok(validation.includes(value), value)
  }
  const pack = read('references/06-build-pack.md')
  assert.match(pack, /执行前单独向用户说明并确认/)
  assert.match(pack, /不自动签名、上传或部署/)
})

test('validate 显式 Manifest 只走前端，后端按 root 发现且不带 config', () => {
  const validation = read('references/05-validation-debug.md')
  const dispatch = validation.split('### validate 的前后端分流')[1].split('## 类型生成纪律')[0]
  assert.match(skill, /`validate \[--root <目录>\]`[^\n]*显式 `--manifest` 只走前端清单校验/)
  assert.match(dispatch, /路径相对 `--root`，`--root` 相对调用 cwd/)
  assert.match(dispatch, /fh2-plugin validate --root <后端插件目录>[^\n]*不传 `--manifest` 或 `--config`/)
  assert.match(dispatch, /显式 `--manifest` 会跳过上下文发现，直接走前端清单校验/)
  assert.match(dispatch, /不能拿后端清单传给它/)
  assert.match(dispatch, /Capability 根[^\n]*`--manifest` 指定一个前端插件[^\n]*不代表其他成员或后端已校验/)
})

test('preview 入口与路由只声明 HTTP PAC 手动闭环，不恢复 HTTPS/证书或两种 SOURCE 路线', () => {
  const routes = skill.split('## references 路由表')[1]
  const previewCommand = skill.split('\n').find(line => line.startsWith('| `preview` |'))
  const validationRoute = routes.split('\n').find(line => line.includes('references/05-validation-debug.md'))
  assert.match(previewCommand, /仅支持 HTTP 目标与 HTTP Origin Proxy\/PAC/)
  assert.match(validationRoute, /HTTP-only PAC\/仅 debug 面板\/登录项目\/手填资源根\/权限同意重载/)
  assert.doesNotMatch(routes, /HTTPS|证书|--cert|--key|--local-protocol|两种 SOURCE/)
  assert.doesNotMatch(previewCommand, /HTTPS|证书|--cert|--key|--local-protocol/)
  assert.doesNotMatch(read('references/00-environment-bootstrap.md'), /两种发行路线/)

  const preview = read('references/05-validation-debug.md').split('### preview（')[1].split('### serve / IDE')[0]
  assert.match(preview, /仅支持完整 HTTP URL[^\n]*HTTP Origin Proxy\/PAC/)
  assert.match(preview, /HTTPS、证书及 `--local-protocol` 路线已撤项，不再使用 `--cert`\/`--key`/)
  assert.match(preview, /不安装证书、不忽略证书告警、不擅自将 HTTPS 目标改为 HTTP/)
  assert.doesNotMatch(preview, /HTTP auto\/http|HTTPS 使用可信本地证书|核对有效期|127\.0\.0\.1 覆盖/)
  assert.match(preview, /PAC 对其他来源走 DIRECT[^\n]*不提供 HTTPS 隧道或保证 WebSocket 联调/)
})

test('preview 依次启用本次 PAC、用户登录项目、仅 debug 面板、手填资源根、权限同意重载、验证与停止', () => {
  const preview = read('references/05-validation-debug.md').split('### preview（')[1].split('### serve / IDE')[0]
  assert.match(preview, /单独确认构建、真实环境访问、浏览器打开、PAC 配置和常驻\/清理影响后启动/)
  const steps = preview.split(/\n\n/)
    .filter(block => /^\d+\. /.test(block))
    .flatMap(block => block.split(/\n(?=\d+\. )/))
    .map(block => block.replace(/\n/g, ' '))
  assert.equal(steps.length, 6)
  assert.match(steps[0], /本次 CLI 分别打印[^。]*PAC 地址、调试面板地址[^。]*插件来源 URL/)
  assert.match(steps[0], /保持进程运行，先配置并启用本次 PAC/)
  assert.match(steps[1], /同一 HTTP Origin 先由用户登录目标环境并进入目标项目，再打开本次完整调试面板地址/)
  assert.match(steps[1], /仅设置 `fh2-plugin-debug=1`，不预填 `fh2-plugin-preview-source` 或 `fh2-plugin-preview-session`/)
  assert.match(steps[1], /退出登录或切换账号[^。]*用户亲自处理[^。]*不代登录、退出或读取凭据/)
  assert.match(steps[2], /手动填写本次[^。]*资源根 URL/)
  assert.match(steps[2], /不是 Entry JS、单插件 Manifest、调试面板地址或 PAC 地址/)
  assert.match(steps[3], /宿主面板校验[^。]*展示插件权限[^。]*用户核对权限[^。]*同意（consent）[^。]*确认[^。]*重载/)
  assert.match(steps[3], /不改写宿主校验、权限或同意规则[^。]*未验证[^。]*不为说明修改 Host/)
  assert.match(steps[4], /ready 或浏览器打开不等于宿主已加载/)
  assert.match(steps[4], /`--no-watch` 只构建一次但代理仍常驻/)
  assert.match(steps[4], /插件 ID 变化需重启[^。]*重新手填本次资源根、校验、同意与重载/)
  assert.match(steps[5], /停止自己的 preview[^。]*Ctrl\+C[^。]*宿主面板禁用本地预览[^。]*恢复本次 PAC\/代理设置/)
  assert.match(preview, /后端仍是目标环境已安装版本，不是本地后端或本地调试页面/)
  assert.match(preview, /报告\/基线只存安全描述，不复制完整会话 URL、Token、Cookie 或私钥/)
})

test('MCP passthrough 只告警未知键名，保留类型校验、默认副作用与知识链接', () => {
  const validation = read('references/05-validation-debug.md')
  const argumentsGuide = validation.split('### 参数与未知键告警')[1].split('### 任务状态')[0]
  assert.match(skill, /接受未知顶层键但忽略其值[^\n]*warnings\[\]\.ignoredArguments[^\n]*已定义键仍[^\n]*类型、枚举与范围/)
  assert.match(argumentsGuide, /所有 MCP 工具接受未知顶层键（passthrough）/)
  assert.match(argumentsGuide, /未知键不会转发给 CLI 或服务/)
  assert.match(argumentsGuide, /structuredContent\.warnings\[\]\.ignoredArguments[^\n]*排序后的未知键名[^\n]*不回显未知值/)
  assert.match(argumentsGuide, /`resource_link` 仍需正常读取[^\n]*不能因告警丢掉原结果或资源链接/)
  assert.match(argumentsGuide, /类型、枚举和范围校验仍生效，错误会拒绝调用/)
  assert.match(argumentsGuide, /`check` 必须是布尔值[^\n]*`mode`[^\n]*枚举[^\n]*`port` 必须是整数/)
  assert.match(argumentsGuide, /路径边界与服务层校验也仍需通过/)
  assert.match(argumentsGuide, /告警在工具执行后附加[^\n]*不表示请求被拒绝、支持该参数或执行只读/)
  assert.match(argumentsGuide, /已定义参数与默认值执行[^\n]*`"--check": true`[^\n]*缺省 `check` 按生成处理，可能已经写盘[^\n]*只检查要传 `check: true`/)
  assert.match(argumentsGuide, /`"--root"` 不是 MCP 的 `path`[^\n]*服务默认根/)
  assert.match(argumentsGuide, /先核对结果、磁盘或任务是否已受理[^\n]*不直接重复可能有副作用的动作/)
  assert.match(skill.split('## references 路由表')[1], /05-validation-debug\.md[^\n]*MCP 未知键告警\/类型校验\/默认动作/)
})

test('IDE 当前内容保存与二次 write 已修正，skipped 归 pending，仍保留 task barrier/partial 限制', () => {
  const validation = read('references/05-validation-debug.md')
  const saving = validation.split('### IDE 保存回执与限制')[1].split('## 来源分层')[0]
  assert.match(saving, /Ctrl\/Cmd\+S 请求保存当前文件[^\n]*自动保存[^\n]*\n工作流视图的「保存」请求 DAG 保存/)
  assert.match(saving, /成功回执只推进\*\*已提交内容\*\*的磁盘基线/)
  assert.match(saving, /保存期间继续编辑的当前内容仍未保存[^\n]*不能把已落盘的旧内容当成已保存当前内容/)
  assert.match(saving, /核对剩余 dirty 内容后再请求下一次保存/)
  assert.match(saving, /首次 `create` 成功[^\n]*`existsOnDisk=true`[^\n]*revision[^\n]*第二次保存走带 `expectedDiskHash` 的 `write`，不再重复 `create`/)
  assert.match(saving, /`FH2_IDE_SAVE_SKIPPED`[^\n]*根本未执行[^\n]*归入 `pending`，不再混进 `failed`/)
  for (const field of ['saved', 'failed', 'conflicted', 'pending', 'partial']) assert.ok(saving.includes(`\`${field}\``), field)
  assert.match(saving, /脚本 → 清单 → 工作流有序保存，失败即停/)
  assert.match(saving, /成功的文件不会自动回滚[^\n]*未落盘内容继续保留/)
  assert.match(saving, /响应丢失时先核对磁盘[^\n]*报告结果未知，不盲重试整批/)
  const rows = saving.split('\n')
  const newFile = rows.find(line => line.startsWith('| IDE_SAVE_NEW_FILE_STATE |'))
  const skipped = rows.find(line => line.startsWith('| IDE_SAVE_SKIPPED_RECEIPT |'))
  assert.match(newFile, /状态路径已修正[^\n]*二次保存走 write/)
  assert.match(skipped, /分类已修正[^\n]*归 pending（未执行），不归普通 failed/)
  assert.doesNotMatch(newFile, /再次编辑保存可能报|待修复/)
  assert.doesNotMatch(skipped, /可能列为失败|待修复/)
  assert.match(saving, /IDE_SAVE_DETACHED_SCRIPT \| 已修正[^\n]*纳入保存计划[^\n]*以回执中出现的路径为准/)
  assert.match(saving, /IDE_SAVE_TASK_BARRIER \| 部分修正[^\n]*新文件[^\n]*404[^\n]*未确认完整落盘不直接启动任务/)
  assert.match(saving, /不替代跨进程事务、同版本权威 checker 或浏览器完整交互验证/)
  assert.match(saving, /旧 manual-guide 可能尚未更新[^\n]*不因此宣布 reviewed Bundle 或开发资产审核已完成/)
  assert.match(skill.split('## references 路由表')[1], /05-validation-debug\.md[^\n]*二次保存 write\/skipped 归 pending\/仍存限制/)
})

test('关键政策语义锚点：探针探测不等于完整验证', () => {
  // 探针/manifest 级探测不得被描述为完整加载或全部就绪（SKILL.md 与 00 均保留该区分）
  assert.match(skill, /manifest 级探测/)
  assert.match(skill, /探针只读取 manifest/)
  assert.match(read('references/00-environment-bootstrap.md'), /仍需真实 CLI 和知识读取复验/)
})

test('关键政策语义锚点：运行时数据术语与两套数据边界', () => {
  // 权威词汇表必须定义开发运行时数据，且与后端知识明确区分
  const planning = read('references/01-planning-spec.md')
  assert.match(planning, /开发运行时数据/)
  assert.match(planning, /developer-runtime\//)
  const backend = read('references/04-backend-guidelines.md')
  assert.match(backend, /开发运行时数据与后端知识/)
})

test('devkit 写法吸收：约束 ID 体系与来源标注存在且可引用', () => {
  // 红线 R1-R4 / 禁令 FV1-FV8 / MCP1-MCP5 与 06 约束自查段
  assert.match(skill, /- \*\*R1 方案未确认就创建\*\*/)
  assert.match(skill, /- \*\*R4 需求没问清就脑补\*\*/)
  const frontend = read('references/03-frontend-guidelines.md')
  for (let i = 1; i <= 8; i++) assert.ok(frontend.includes(`| FV${i} |`), `FV${i}`)
  const validation = read('references/05-validation-debug.md')
  for (let i = 1; i <= 5; i++) assert.ok(validation.includes(`| MCP${i} |`), `MCP${i}`)
  const pack = read('references/06-build-pack.md')
  assert.match(pack, /## 约束自查[\s\S]*只列本次实际命中[\s\S]*句子是权威定义，ID 只是索引/)
  assert.match(pack, /可用 ID 来源：红线 R1-R4（SKILL\.md）、View 禁令 FV1-FV8（03）、MCP 任务纪律 MCP1-MCP5（05）/)
  // 来源层级表与需验证信号（01 方案概要 + SKILL 交付汇报）
  const planning = read('references/01-planning-spec.md')
  for (const marker of ['[来源: 生成类型]', '[来源: 契约事实]', '[来源: 知识条目]', '[来源: 用户原话]', '[需验证]']) {
    assert.ok(planning.includes(marker), marker)
  }
  assert.match(planning, /查证不到声明的事实标「需验证」并停止该细节设计，不静默输出/)
  assert.match(skill, /平台事实逐条带来源层级[\s\S]*标「需验证」，不静默输出/)
})

test('devkit 写法吸收：判域负触发与触发验证语句', () => {
  // SKILL.md 有独立的负触发表：三类不该进入本流程的任务
  const negative = skill.split('## 什么时候不要用')[1].split('## 四条红线')[0]
  assert.match(negative, /改宿主自身页面或组件[\s\S]*不进入本流程/)
  assert.match(negative, /纯运维操作[\s\S]*插件开发授权不含这类操作/)
  assert.match(negative, /只问概念[\s\S]*不启动流程/)
  // README 触发验证表：测试输入 + 期望标志
  const readme = read('README.md')
  assert.match(readme, /触发验证[\s\S]*任何一条不匹配，都说明没装好或没加载对/)
  for (const phrase of ['给驾驶舱加个工具栏按钮', '怎么用', '帮我改宿主登录页的按钮', '初始化 Toolchain']) {
    assert.ok(readme.includes(phrase), phrase)
  }
  assert.match(readme, /进入 Step 1A 需求澄清提问（分轮、带推荐项），而不是直接跑 `create`/)
  assert.match(readme, /判域不适用：说明这是普通宿主应用开发/)
})

test('触发面覆盖司空中文别名，且负边界可判定', () => {
  const description = skill.split('---')[1]
  // 中文产品名是主要触发词：司空 / 司空2 / 大疆司空。
  assert.match(description, /司空/)
  assert.match(description, /司空2/)
  assert.match(description, /大疆司空/)
  // 触发意图在功能描述之前：description 第一句先说「什么时候用」。
  const firstSentence = description.split('。')[0]
  assert.match(firstSentence, /司空/)
  assert.match(firstSentence, /插件开发技能|插件开发/)
  // 负边界写成可判定的条件，不用「与插件契约无关」这类循环定义。
  assert.match(description, /只问概念、不要求改代码时不要用/)
  assert.match(description, /操作对象不是插件工程/)
  assert.doesNotMatch(description, /与插件契约无关/)
})

test('术语统一：对齐平台手册，不再混用旧叫法', () => {
  // 手册 11.glossary.md 用「能力工程 / 上传包 / 扩展点 / 本地调试页面 / 司空」。
  const forbidden = /Capability 工作区|行业包|Mock Host|Mock Workbench|能力工程根工作区/
  for (const file of consumerDocs()) assert.doesNotMatch(read(file), forbidden, file)
  // 司空必须在入口定义一次，且说明它是中文产品名。
  assert.match(skill, /司空（FH2，即 FlightHub 2）/)
  // 代码标识保持源码原样，不做翻译。
  for (const token of ['capability-fullstack', 'fh2-plugin.json', 'packages.json', 'capabilities.json', 'ctx.styleTarget', 'ctx.overlayElement']) {
    assert.ok(consumerDocs().some(file => read(file).includes(token)), token)
  }
  // 01 的词汇表是唯一术语权威，且不再只写「避免混用」三列。
  const planning = read('references/01-planning-spec.md')
  assert.match(planning, /## 领域词汇表[\s\S]*\| 术语 \| 定义 \| 代码标识 \| 容易混用的说法 \|/)
  for (const term of ['能力工程', '上传包', '扩展点', '本地调试页面', '司空', '授权源码', '开发运行时数据', '后端知识']) {
    assert.ok(planning.includes(term), term)
  }
})

test('可读性门禁：正文行不超长，不用破折号', () => {
  for (const file of consumerDocs()) {
    const content = read(file)
    assert.doesNotMatch(content, /——/, `${file}: 破折号`)
    for (const line of proseLines(content)) {
      assert.ok([...line].length <= 160, `${file}: 正文行 ${[...line].length} 字符：${line.slice(0, 40)}…`)
    }
  }
})

test('references 骨架完整：何时读取 / 前置条件 / 出口条件 / 反模式', () => {
  for (const reference of references) {
    const content = read(`references/${reference}`)
    assert.match(content, /何时读取[：:]/, reference)
    // 前置条件可以是 `## 前置条件` 段，也可以是文首 `前置条件：` 一行；二选一。
    assert.match(content, /(?:^## 前置条件|^前置条件：)/m, reference)
    assert.match(content, /## 出口条件/, reference)
    assert.match(content, /## 反模式/, reference)
    // 出口条件必须是可勾选清单，且至少两条（单条等于没门槛）。
    const exits = content.split('## 出口条件')[1].split('## 反模式')[0]
    const checks = exits.match(/- \[ \]/g) ?? []
    assert.ok(checks.length >= 2, `${reference}: 出口条件只有 ${checks.length} 条`)
  }
})

test('交付闭环：创建一律完整能力工程，单插件模板不是 Skill 路径', () => {
  const planning = read('references/01-planning-spec.md')
  const scaffold = read('references/02-scaffold-contract.md')
  // 01 拓扑决策：一律 capability-fullstack，插件组合制，加插件指路
  const topology = planning.split('2. **拓扑决策**')[1].split('3. **扩展点与权限选型**')[0]
  assert.match(topology, /`capability-fullstack`[\s\S]*完整能力工程/)
  assert.match(topology, /组合[\s\S]*模板示例[^\n]*按方案增删/)
  assert.match(topology, /已有能力工程要新增插件[\s\S]*不新建工程[\s\S]*02/)
  assert.match(topology, /不是 Skill 路径[\s\S]*pack 产物不可上传/)
  // 反向守卫：旧路由句不得回流
  assert.doesNotMatch(planning, /纯前端交互[^\n]*`frontend-basic`/)
  assert.doesNotMatch(planning, /纯服务端能力[^\n]*`backend-basic`/)
  // 02：单模板收敛 + 加插件/目录发现制/capabilityIds 双向一致
  assert.match(scaffold, /Skill 只引导创建完整能力工程；`frontend-basic` \/ `backend-basic` 单插件模板不是 Skill 路径/)
  const commands = [...scaffold.matchAll(/```sh\s*([\s\S]*?)```/g)].map(match => match[1]).join('\n')
  assert.doesNotMatch(commands, /--template (?:frontend|backend)-basic/)
  const members = scaffold.split('## 往现有能力工程加插件')[1].split('## 创建后检查清单')[0]
  assert.match(members, /目录发现制/)
  assert.match(members, /目录名必须与清单里的插件 ID 一致/)
  assert.match(members, /`file:` SDK\/Toolchain/)
  assert.match(members, /`capabilityIds` 登记[\s\S]*双向一致/)
  assert.match(scaffold, /用单插件模板新建"交付用"工程[\s\S]*不走加插件路径而另起炉灶/)
})

test('create 命令只有一处权威示例，其他文档只指路', () => {
  const scaffold = read('references/02-scaffold-contract.md')
  assert.match(scaffold, /本文件是 create 的唯一权威示例处/)
  const createCommands = content => [...content.matchAll(/```sh\s*([\s\S]*?)```/g)]
    .map(match => match[1])
    .filter(block => /fh2-plugin\.mjs"? create|fh2-plugin create/.test(block))
  assert.equal(createCommands(scaffold).length, 1, '02 必须有且只有一条 create 示例')
  for (const reference of references.filter(file => file !== '02-scaffold-contract.md')) {
    assert.equal(createCommands(read(`references/${reference}`)).length, 0, `${reference} 不应再内联 create 命令`)
  }
  // 指路的说法要存在，读者找得到 02。
  for (const reference of ['references/00-environment-bootstrap.md', 'references/01-planning-spec.md']) {
    assert.match(read(reference), /02/, reference)
  }
})

test('交付闭环：pack 判根、单插件根不 pack、生态签名语义', () => {
  const pack = read('references/06-build-pack.md')
  // 判别表：三类根标记 → 制品与可上传性
  const dispatch = pack.split('## 执行目录与制品判别')[1].split('## 打包（pack）')[0]
  for (const row of ['`packages.json`（能力工程根）', '`capabilities.json`（能力根）', '`fh2-plugin.json`（单插件根）', '独立插件交付物 + zip']) {
    assert.ok(dispatch.includes(row), row)
  }
  assert.match(dispatch, /Skill 只在能力工程根或能力根执行 pack/)
  assert.match(dispatch, /单插件根不执行 pack[\s\S]*迁移[\s\S]*能力工程根/)
  // 生态签名语义：不带签名是平台设计，不作告警
  assert.match(pack, /生态包不带签名是平台设计/)
  assert.match(pack, /官方发布包的 Ed25519 签名属独立发布流程[\s\S]*不把"未签名"当缺陷/)
  assert.match(pack, /pack 不自动签名、上传或部署/)
  assert.match(pack, /上传与平台安装是后续独立步骤[\s\S]*未执行的上传\/安装如实标注未验证/)
  // SKILL.md pack 行同步
  assert.match(skill, /单插件根不走这条路径；生态包不带签名是平台设计/)
  assert.match(skill, /Skill 只引导 `capability-fullstack` 建完整能力工程/)
  // 00 的 create 示例不再教单插件模板
  assert.doesNotMatch(read('references/00-environment-bootstrap.md'), /--template (?:frontend|backend)-basic/)
  // 反向守卫：告警式签名表述不得回流
  for (const [file, content] of [['SKILL.md', skill], ['references/06-build-pack.md', pack]]) {
    assert.doesNotMatch(content, /未签名交付物|未签名制品|不代表目标环境|不证明目标 Worker/, file)
  }
  // 既有事实句保留
  assert.match(pack, /执行前单独向用户说明并确认/)
})

test('View 样式/浮层规则为普适纪律 + 常见问题症状表，不 case-by-case 叙述', () => {
  const frontend = read('references/03-frontend-guidelines.md')
  // 纪律层：View 运行域纪律节内含普适规则句（不提具体库名）
  const discipline = frontend.split('## View 运行域纪律')[1].split('## Plugin Entry 写法纪律')[0]
  assert.match(discipline, /`ctx\.styleTarget`（组件库 \/ CSS-in-JS 样式挂载点）/)
  assert.match(discipline, /`ctx\.overlayElement`（弹层浮层目标，与挂载点同一 ShadowRoot）/)
  assert.match(discipline, /默认把样式挂 `document\.head`、弹层 teleport 到 `document\.body`/)
  assert.match(discipline, /必须显式改向契约目标[\s\S]*FV4\/FV7/)
  assert.doesNotMatch(discipline, /naive-ui/)
  // 症状层：常见问题表三行（症状 → 根因 → 修复），库名仅作「如」例
  const faq = frontend.split('## 常见问题')[1].split('## 出口条件')[0]
  assert.match(faq, /组件库组件渲染无样式[\s\S]*不穿透 View 的 ShadowRoot[\s\S]*`ctx\.styleTarget`/)
  assert.match(faq, /弹层无样式或定位错乱[\s\S]*teleport 到 `document\.body`[\s\S]*`ctx\.overlayElement`/)
  assert.match(faq, /「全局样式」组件兜底[\s\S]*`document\.body` 的全局样式[\s\S]*FV7/)
  assert.match(faq, /具体 prop 名以工程安装版本实际 API 为准/)
  // 反模式保留规则式条目
  assert.match(frontend, /组件库样式\/弹层挂在 ShadowRoot 外（head\/body）导致无样式或污染宿主，再用全局样式组件兜底/)
  // SKILL 路由表 03 行可发现该主题（含常见问题入口）
  assert.match(skill, /references\/03-frontend-guidelines\.md` \| 开发运行时数据查证[\s\S]*ShadowRoot 样式挂载与浮层[\s\S]*常见问题/)
})

test('后端指南讲清架构与形态选型，不只给查证流程', () => {
  const backend = read('references/04-backend-guidelines.md')
  // 是什么：不是 Node 服务，沙箱同步，构建产物只装 dist/
  assert.match(backend, /## 后端插件是什么[\s\S]*不是一个服务进程/)
  assert.match(backend, /## 组成部分[\s\S]*dist\//)
  // 四种执行形态必须都在，且各自点名
  const forms = backend.split('## 四种执行形态怎么选')[1].split('## 暴露接口')[0]
  for (const form of ['httpHandler', 'eventHandler', 'workflowAdapter', 'evaluator']) {
    assert.ok(forms.includes(form), form)
  }
  assert.match(forms, /5000ms/)
  assert.match(forms, /10000ms|30000ms/)
  // 沙箱限制必须讲，且给替代做法
  const limits = backend.split('## 源码限制')[1].split('## 四种执行形态')[0]
  for (const token of ['setTimeout', 'async', 'FH2_BACKEND_ASYNC_FORBIDDEN', 'FH2_BACKEND_TIMER_FORBIDDEN']) {
    assert.ok(limits.includes(token), token)
  }
  // 数据三层与硬规则
  const data = backend.split('## 数据：schema.sql')[1].split('## 流程编排')[0]
  for (const token of ['plugin_db_', 'createIfAbsent', 'setnx']) assert.ok(data.includes(token), token)
  // DAG 必须有触发轴、动作、收尾特例
  const dag = backend.split('## 流程编排（DAG）')[1].split('## 动态脚本')[0]
  for (const token of ['schedule', 'bizNotify', 'dispatch_mission', 'allDone', '$state', 'needs']) {
    assert.ok(dag.includes(token), token)
  }
  // 事件入口必须讲清"返回什么决定消息去哪"
  const events = backend.split('## 四种执行形态怎么选')[1].split('## 暴露接口')[0]
  assert.match(events, /必须返回对象/)
  for (const token of ['NOT_FOUND', 'INVALID_ARGUMENT', '有界重试', '不重投']) {
    assert.ok(events.includes(token), token)
  }
  // DAG 与脚本的判据必须可判定
  const script = backend.split('## 动态脚本与 Evaluator')[1].split('## 开发运行时数据')[0]
  assert.match(script, /run_script/)
  assert.match(script, /没有目录发现|无目录发现/)
  assert.match(script, /allowlist` 恒为空|allowlist 恒为空/)
})

test('前端指南讲清架构与宿主，不只给禁令表', () => {
  const frontend = read('references/03-frontend-guidelines.md')
  assert.match(frontend, /## 前端插件是什么[\s\S]*不是独立网页/)
  // 四个宿主与运行时差异
  const architecture = frontend.split('## 技术架构概览')[1].split('## 组成部分')[0]
  for (const host of ['cockpit', 'plan', 'message', 'project']) assert.ok(architecture.includes(host), host)
  assert.match(architecture, /isolated-realm/)
  assert.match(architecture, /isolated-iframe/)
  // 组成部分与依赖方向
  const parts = frontend.split('## 组成部分')[1].split('## 两个 ctx')[0]
  for (const token of ['src/plugin.ts', 'src/hosts/', 'src/views/', 'definePlugin', '一 View 一入口']) {
    assert.ok(parts.includes(token), token)
  }
  // 两个 ctx 的边界
  const ctx = frontend.split('## 两个 ctx')[1].split('## 扩展点')[0]
  assert.match(ctx, /View 拿不到 `ctx`/)
  assert.match(ctx, /definePluginView/)
  // 扩展点两类贡献方式与选型
  const points = frontend.split('## 扩展点：往哪放东西')[1].split('## 能力：能做什么')[0]
  assert.match(points, /`onTrigger`/)
  assert.match(points, /`render: \(\) => ViewHandle`/)
  assert.match(points, /与各插件 `activate\(\)` 完成先后无关/)
  // 能力：facade 与 undefined 正常路径
  const capabilities = frontend.split('## 能力：能做什么')[1].split('## 调用后端')[0]
  assert.match(capabilities, /返回 `undefined` 是\*\*正常路径\*\*/)
  assert.match(capabilities, /facade/)
  assert.match(capabilities, /ctx\.capabilities\.get/)
})

test('前后端调用链路在两个指南里对得上', () => {
  const frontend = read('references/03-frontend-guidelines.md')
  const backend = read('references/04-backend-guidelines.md')
  const calling = frontend.split('## 调用后端')[1].split('## 契约查询流程')[0]
  const exposed = backend.split('## 暴露接口')[1].split('## 被流程编排调用')[0]

  // 同步接口：两个方向必须写同一个端点与同一组顶层字段
  for (const side of [calling, exposed]) {
    assert.ok(side.includes('/plugin/invoke'))
    for (const field of ['pluginId', 'handler', 'input']) assert.ok(side.includes(field), field)
  }
  // 信封与失败语义两侧一致
  assert.match(calling, /完整信封/)
  assert.match(calling, /PLUGIN_GATEWAY_ERROR/)
  assert.match(exposed, /40001|40006|20001/)
  // endpoint 硬规则：单 / 开头、不带 /plugin-api 前缀
  assert.match(calling, /不带 `\/plugin-api` 前缀/)
  assert.match(calling, /PLUGIN_NETWORK_BLOCKED/)

  // 流程链路：前端会起、后端会接
  assert.match(calling, /POST \/flows\/\{flowName\}\/start/)
  assert.match(calling, /\/signals\/\{signal\}/)
  assert.match(calling, /编排进度，不是业务状态/)
  const launching = backend.split('## 启动流程与回推前端')[1].split('## 数据：')[0]
  assert.match(launching, /flow\.start/)
  assert.match(launching, /`job` 触发轴的流程\*\*只能\*\*被它启动/)

  // 推送链路：bizCode 两侧成对，且都强调改一侧不断另一侧
  assert.match(calling, /onBizCode/)
  assert.match(calling, /`bizCode` 必须与后端 `notify\.publish` 的 `bizCode` \*\*完全一致\*\*/)
  assert.match(launching, /notify\.publish[\s\S]*bizCode[\s\S]*onBizCode/)
  // 本地边界两侧都要说
  assert.match(calling, /本地 Gateway[\s\S]*没有 start 路由/)
  assert.match(backend, /## 本地验证边界[\s\S]*start` 端点/)
})

test('快照不当契约：字段清单必须指向实际枚举', () => {
  const frontend = read('references/03-frontend-guidelines.md')
  const backend = read('references/04-backend-guidelines.md')
  for (const [name, content] of [['03', frontend], ['04', backend]]) {
    assert.match(content, /实际枚举为准|走 `search_knowledge` 查证|按 `search_knowledge` 查/, name)
  }
  // 能力/点位/动作的具体清单不在 Skill 里冻结
  assert.match(frontend, /本文不抄清单/)
  assert.match(backend, /本文不抄清单/)
})
