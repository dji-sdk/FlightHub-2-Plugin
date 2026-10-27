# 示教复飞（录制期）插件 · official_patrol_teach

本插件提供示教复飞录制期的后端能力：航线录制状态维护、航点增删改查、航点截图
凭据与关联、复飞航线生成。它由平台原生后台服务的同名能力逐个接口移植而来，
接口语义与原生实现对齐；与原生行为的偏差逐条记录在本文与各 Handler 文件头，
二开前先读「§一 契约」与「§三 平台边界与避坑」。

> 工程说明：全部 Handler 为 ESM TypeScript；`schema.sql` 是运行时实体与 DDL 的
> 唯一事实来源；业务代码通过字符串实体名调用通用 `shared/store.ts`，不生成
> `types/storage.ts` facade。

**十二个入口**：

| 原生 HTTP 路由（移植来源） | 插件 handler | 脚本 |
| --- | --- | --- |
| `POST /patrol/teach/routes/enter` | `teach.enter-route` | `handlers/teach/enter-route.ts` |
| `GET /patrol/teach/routes/status` | `teach.get-route-status` | `handlers/teach/get-route-status.ts` |
| `POST /patrol/teach/routes/:id/waypoints` | `teach.append-waypoint` | `handlers/teach/append-waypoint.ts` |
| `DELETE /patrol/teach/routes/:id` | `teach.delete-route` | `handlers/teach/delete-route.ts` |
| `PATCH /patrol/teach/waypoints/:id` | `teach.update-waypoint` | `handlers/teach/update-waypoint.ts` |
| `DELETE /patrol/teach/waypoints/:id` | `teach.delete-waypoint` | `handlers/teach/delete-waypoint.ts` |
| `GET /patrol/teach/routes` | `teach.list-routes` | `handlers/teach/list-routes.ts` |
| `GET /patrol/teach/routes/:id` | `teach.get-route` | `handlers/teach/get-route.ts` |
| `PATCH /patrol/teach/routes/:id` | `teach.update-route` | `handlers/teach/update-route.ts` |
| `POST /patrol/teach/routes/:id/generate` | `h_teach_generateWayline` | `handlers/teach/generate-wayline.ts` |
| `POST /patrol/teach/routes/:id/screenshot-sts` | `h_teach_createScreenshotSTS` | `handlers/teach/create-screenshot-sts.ts` |
| `POST /patrol/teach/waypoints/:id/screenshot` | `h_teach_attachScreenshot` | `handlers/teach/attach-screenshot.ts` |

⚠️ **路径参数与 query 参数全在 `input` 里**（`teach_route_id` / `waypoint_id` 都是 UUID
字符串；列表的筛选与分页同样在 `input` 里，不是 query 串）——平台只有 `<prefix>/invoke`
一条路由，所有入参都在单信封的 `input` 里。

截图三段式两条都是 JS Handler：`createScreenshotSTS` 调 hostCapability
（`screenshot:issueupload`，查库 + 取 STS 在 Host 侧，凭据只进本次响应）；
`attachScreenshot` 纯 CRUD（读航点 → 校验 object_key 前缀 → `store.update`）。

★ **`teach.get-route-status` 能回航点**——它与 `teach.get-route`
共用同一套分页取点逻辑。⚠️ 于是它也继承了那条上限，见 §二之三。

★★ `h_teach_generateWayline` 与 `h_teach_createScreenshotSTS` 是 12 个 Handler 中
仅有的两个调 hostCapability 的入口（`wayline:generate` / `screenshot:issueupload`）；
其余十个只碰 `data:read` / `data:write` / `screenshot:signurl`。

## 一、这一路的契约（读代码前先看这几条）

| 事实 | 出处 |
| --- | --- |
| 清单里**没有 `handlers[]`**，handler 名由目录派生，分隔符转点 | 平台插件运行时 |
| 入口**恒为 `handle(input, ctx)`** | 平台插件运行时 |
| **没有入参/出参投影、没有必填校验**：input 整块递进来，返回值原样到前端 | 同上（`IO` 留空） |
| 能力面按**插件维度**给（顶层 `allowlist`），⚠️ 读写分权没有了 | 平台插件清单 |
| `_` 开头的文件**整包拒装**（内建装配模式带不动），故助手每份脚本各带一份 | 平台插件装配 |
| `entities[]` **只做展示**，平台不读它；列名由脚本直接给物理名 | 平台数据存储层 |
| 业务列一律 **TEXT**，只写得进字符串 | 平台数据存储层 |
| store 是 6 个方法：`query` / `count` / `insert` / `createIfAbsent` / `update` / `delete` | 平台存储 API |
| `delete(entity, filter)` 收的是**过滤条件**，不是 id | 同上 |
| `orderBy` **必须是数组**（`[{field,dir}]` 或 `[{x:"desc"}]`），传裸对象回 `INVALID_FILTER` | 平台存储 API |
| 业务表**平台不建、不对账**；`plugin_db_teach_route` 是一条**例外**，由平台内置迁移建 | 平台内置迁移 |
| 脚本可以打诊断日志 `log.info/warn/error(msg, {标量字段})`，**不进 allowlist** | 平台宿主 API |

## 二、进入录制怎么落的

原生服务靠一条部分唯一索引 `UNIQUE (flight_id) WHERE status = 'recording'` 保证
「同一架次同时只有一条录制中航线」，撞索引就回 409 并带上赢家摘要。

插件这一路换成 **锁列 + `createIfAbsent`**：

- `recording_flight_id`：录制中写 `flight_id`，生成后置 `NULL`（NULL 在唯一索引里互不相等，
  所以同一架次可以有任意多条 `generated` 航线）。
- `store.createIfAbsent("teach_route", record, ["recording_flight_id"])`
  → `created === true` 就是新建；`created === false` = 这个架次已经有人在录 → 回 `CONFLICT`。
  ⚠️ **不是**「先查再写」——并发下那种写法必然产生两条，而且本地跑不出来。

与原生实现的偏差（`project_id` 变必填、id 是 UUID、CONFLICT 带不了 existing 摘要、
航线名的时区）逐条写在 `handlers/teach/enter-route.ts` 的实现注释里，改代码前先读那段。

## 二之二、查录制状态怎么落的

原生服务按 `flight_id` 查、再在服务里判 `status = 'recording'`。插件这一路**按锁列查**：

```js
store.query("teach_route", {recording_flight_id: {eq: flightId}}, {limit: 1})
```

`recording_flight_id` 的定义就是「这个架次当前正在录的那一条」，于是：

- 一个等值条件就够，且落在 `uniq_teach_route_recording_flight` 上——O(1)；
- 唯一索引保证最多命中一条，不必再挑「哪条才算当前」；
- ★★ 与 `enter-route` 的互斥判据是**同一列**，两个入口不可能各自算出不同答案。
  换成 `{flight_id, status}` 的话判据就成了两处，而它们哪天不一致（比如将来的
  `generate` 只改了 `status`、忘了清锁列）就会一个入口说在录、另一个说没在录。

⚠️ 锁列命中但 `status !== "recording"` 时**不报错也不纠正**（锁列是判据），
但打一条 `log.warn`——否则这种库内自相矛盾会一直没人知道。

其余偏差（id 是字符串、三个数字列要 `Number()`、时刻列 UTC）
写在 `handlers/teach/get-route-status.ts` 的实现注释里。
★ 它的 `waypoints` 与 `teach.get-route` 走同一套 `fetchWaypoints`（见 §二之三）。

## 二之三、列表 / 详情 / 改航线怎么落的

这三个是**查询侧**（外加一个只改两个字段的写），坑与前面几个入口完全不同。

### ⚠️⚠️ 列表的航点数是逐行数出来的：一页 N 行 = N+1 次查询

原生服务一条 SQL 出整页（相关子查询）：

```sql
SELECT r.*, (SELECT COUNT(*) FROM waypoints w WHERE w.teach_route_id = r.id) FROM routes r …
```

平台的 store 只有六个方法，**没有 join、没有聚合、没有 group by**——于是只能
「查一页航线，再对当页每一行各打一次 `count`」。这笔账付得起，但要知道它的形状：

| 事实 | 数 | 出处 |
| --- | --- | --- |
| `count` 走 `uniq_teach_waypoint_route_seq` 的最左前缀，不扫记录 | 单次 1~5ms | 索引定义 |
| 沙箱超时是**硬上限**，不是配置项 | 5 秒 | 平台沙箱执行 |
| 沙箱 JS 单线程，这 N+1 次只能**串着走** | 一页 100 行 ≈ 100~500ms ≈ 10% 预算 | 平台沙箱执行 |
| 库连接池**全进程共享** | 10 条 | 平台运行配置 |

⚠️⚠️ 真正的风险在**并发**，不在单次延迟：多个座舱同时开列表页时这些查询要排队，
撞上了的表现是**沙箱 5 秒超时把脚本整个杀掉**——用户看到「列表打不开」，
而且是忽好忽坏、跟负载走，本地永远复现不出来。
★ 故 `page_size` **上限收到 100**（原生是 200），缺省仍是 20（与原生一致，
座舱实际用的就是这个，故常态下这个偏差碰不到）。钳制是**静默**的，与原生同款。

★ **为什么不在航线行上存一个 `waypoint_count` 列**（那样列表页就是 1 次查询）：
那个列只能靠「追加/删除航点时读改写地增减」维护——没有事务，并发下会丢更新，
而一个飘了的航点数是**永久的**，且用户正拿它判断「这条录制够不够生成」。宁可多打 100 次 `count`。

★ 门禁钉死了「3 行 = 3 次 count，且逐行的 filter 不同」，
并要求日志里出现 `count_queries=3`——那是这笔账的唯一现场证据（本包 `tests/`）。

### ⚠️⚠️ 列表**排不了创建时间倒序**，只能按 id 倒序

平台存储层对排序字段只放行 `"id"`，别的排序字段都当业务字段处理，而
`snakeCase("createdAt") = "created_at"` 正好撞上**平台保留列名表**→ 回 `UNKNOWN_FIELD`。
★ 即「按创建时间排序」这件事**在当前平台上写不出来**，不是我们没写。

于是退而按 `id` 倒序。⚠️⚠️ 这**不等价**于按创建时间倒序：id 是平台生成的 UUID，
两条航线的 id 大小与它们的创建先后**没有任何关系**——

- 列表顺序在用户看来是**随机的**（不再是「最近录的排在最前」，前端别再假定这一条）；
- 但它是**稳定的**（同样的库、同样的页回同样的顺序），故 `limit`/`offset` 翻页语义成立。
  ★ 完全不给 `orderBy` 才是真正的坑：无序表上的 `limit`/`offset` 在 PG 里是未定义行为，
  表现是翻页时有的航线出现两次、有的一次都不出现。

⚠️ 要恢复「最近优先」，得给航线表加一列**定宽**的 `created_at_ms`（与航点 `seq` 定宽同一手法，
TEXT 上的字典序才等于数值序），那是一次 migration + 改 `enter-route` 写入——不在本次范围。

### ⚠️⚠️ 详情的航点靠分页循环取，最多 5000 个

平台单次查询上限 `maxQueryLimit = 1000` 行，而一次半小时的录制按 1 点/秒约 **1800 个点**——
一次取不完。故 `fetchWaypoints` 是个循环：每页 1000，最多 5 页。

- ⚠️⚠️ 循环**必须有上限**。没有的话，一条被写坏的数据（比如某天 `seq` 分配出了环）
  会让这个 handler 一直翻页到 5 秒超时——而超时的表现是「详情页打不开」，看不出是数据问题。
  ★ 有上限则退化成「点少了一截 + 一条 warn」，可查。5000 点 ≈ 83 分钟连续录制，远超实际。
- ⚠️ 撞上上限时**不报错**：回已取到的点 + `waypoints_truncated: true`。报错的话用户连前
  5000 个点都看不到。★ 但**前端必须读那个键**——不读的表现是「航线看着只有 5000 个点」，
  而库里有更多。它是**平台这一路独有的**，原生实现没有这个字段。
- ⚠️ 翻页判据是「这一页取回的行数 < 页大小」而**不是**「取够 `total` 了」：
  `total` 是查询那一刻的总数，翻页途中有人加点的话它是过期的，于是循环永远停不下来。
- ★ 另一道闸是**字节预算**（`maxResultBytes = 1 MiB/次`）。按一个航点约 300 字节估，
  单次约 3000 行才撞得到——故 1000 行那道先到，字节这道在本入口碰不上。
- ⚠️ 按 `seq` 升序**能成立全靠 seq 定宽**（同 §二之四）。

★ 门禁逐档钉死：0 / 999 / 1000 / 1001 / 1800 / 5000 / 5001
各该翻几页、回几个点、`truncated` 是什么，外加
offset 档（offset 忘了乘页号 = 同一页取五遍，而报文一切正常）。

### ★ 详情回 `screenshot_url`（`screenshot:signurl` 能力）

`get-route` / `get-route-status` 的 `allowlist` 申了 `screenshot:signurl`，
平台宿主注入 `screenshot.signUrl(key)` 函数（12 小时 presigned GET URL，与原生实现
同款）。凭据不进 JS（与 `wayline:generate` 同一纪律）。

### ⚠️⚠️ 改航线：状态判据必须进 filter

可改的只有 `name` 与 `global_speed` 两个，且**至少要传一个**（与改航点同一条纪律）。
⚠️⚠️ **`waypoint_speed` 不在可改之列——这一条是坑，不是遗漏**。航线表上有两个速度，
它们喂给 KMZ 的是不同位置：

| KMZ 里的位置 | 取自 |
| --- | --- |
| `waylines.wpml` 的 `autoFlightSpeed` | `global_speed` |
| `template.kml` 的 `autoFlightSpeed` | `waypoint_speed` ← **同名字段，填的不是同一个** |
| 每个 Placemark 的 `waypointSpeed` | `waypoint_speed` |

★ 原生服务这个接口也只放开 `global_speed`。「顺手把两个速度统一了」是照抄时最容易犯的错，
表现是生成出来的航线飞起来比设定的快或慢，而面板上显示的值是对的。

**只有 `recording` 的航线能改**：`generated` 是终态，名字和速度都已经烧进 KMZ 并登记到
文件服务了，改库里这份只会让两边对不上，而且**无从察觉**。
⚠️⚠️ 那个状态判据**必须与 id 一起进 filter**，不能「先查是不是 recording、再发 update」——
两者之间 `generate` 刚好跑完的窗口里，这次修改会落到一条已生成的航线上，而那正是要拦的情况。
★ 平台的 filter 支持多条件 AND，故 `{id:{eq:…}, status:{eq:"recording"}}` 一条写就够，
结果只看 `affected`。

⚠️⚠️ **`affected === 0` 回 `CONFLICT`，不回 `NOT_FOUND`**。这时分不清「航线不存在」与
「已生成」——原生实现同样分不清，取舍也一样：
「真的不存在时也走这条——代价只是错误码偏保守，比抹掉一条真实航线小得多」。
★ 回 404 会让前端把这条从列表里抹掉，而它多半好好地在那儿。

⚠️ 名字判的是**码点数**不是字节数（`name.length ≤ 128`，与原生 `len([]rune(name))` 同口径）：
一个汉字 UTF-8 占 3 字节，按字节判的话 43 个字的正常中文名就会被拒，而用户数了数明明只有 43 个字。
★ 速度区间 `[0.1, 15]`，⚠️ 布尔要单独拦——`Number(true)` 是 1，不拦的话飞机真会按 1 m/s 飞完全程。

★ 出参与 `teach.get-route` **逐字段同形**（共用 `routeView` / `fetchWaypoints` / `waypointView`），
前端一套解析走两处；门禁拿两个 handler 的报文逐字节比。

### ★ `routeView` 与 `summaryView` 是两个函数，不是漂移

列表项（`summaryView`，多 `waypoint_count`、少生成产物与航点）与详情（`routeView`）
形状本就不同。⚠️ 同名会触发助手漂移门禁，**而那道门禁是对的**——
逐字节不一致的两个函数本就不该共用一个名字：
「刻意的差异说明它不该叫同一个名字」。

## 二之四、追加航点怎么落的

原生服务是**一条 SQL**：`INSERT … SELECT COALESCE(MAX(seq),-1)+1 … RETURNING`，
外加同事务里 `UPDATE … WHERE status='recording'` 锁住航线状态。
插件这一路**没有事务、也没有 `MAX()`**，于是拆成三步：

1. `query("teach_route", {id:{eq:…}}, {limit:1})` —— 不在回 `NOT_FOUND`；
   在但 `status !== "recording"` 回 **`CONFLICT`**（航线在，只是终态只读，
   回 `NOT_FOUND` 会让用户看着那条航线却被告知「不存在」）。
2. `query("teach_waypoint", {teach_route_id:{eq:…}}, {orderBy:[{seq:"desc"}], limit:1})`
   取当前最大 `seq`，加一。
3. `createIfAbsent("teach_waypoint", rec, ["teach_route_id","seq"])`。

### ⚠️⚠️ `seq` 是定宽零填充的六位串

业务列一律 TEXT，而 **TEXT 上的大小比较按字典序** —— 不定宽的话 `"10" < "2"`，于是
第 2 步从**第 10 个点**起开始拿错值，表现是航点顺序错乱、复飞时飞机按错的次序走一遍，
而库、平台、前端**没有任何一处会报错**。
★ 「定宽是插件的义务，平台判不了」这是平台存储层自己声明的约束，这里就是那句话的落点。
⚠️ 宽度 6 = 每条航线最多 999999 个点，越界回 `LIMIT_EXCEEDED` **当场拒**，
不静默进位成 7 位（`"1000000" < "999999"`，那一刻起排序全乱）。

### ★ 撞车靠复合唯一索引 + 重试，不是靠事务

第 2 步与第 3 步之间有窗口。撞上了**不会写错数据**——
`uniq_teach_waypoint_route_seq (teach_route_id, seq)` 挡住第二个写手，
它拿到 `created === false`，脚本当场重新取一次最大 `seq` 再试（最多 3 次，
用尽回 `CONFLICT` +「请重试」，与原生同档）。

⚠️⚠️ `created === false` 时 `createIfAbsent` 回的 `record` 是**别人那个点**，
绝不能把它当本次结果回出去——那样前端会显示「已加一个点」、点数也涨了，
而这次录的坐标**一个字都没进库**，飞手要到复飞时才发现少一个点。
（本包 `tests/` 里有一条专门钉这个的用例。）

### ⚠️⚠️ 两个取错了不会报错的字段

| 字段 | 座舱该取 | 取错了会怎样 |
| --- | --- | --- |
| `height` | OSD 的 `height`（**WGS84 椭球高，绝对高度**） | 取成 `elevation`（相对起飞点）→ 把 171 m 的椭球高当相对高度，飞机直接爬升上百米 |
| `camera_yaw` | OSD 的 `gimbal_yaw`（**相机偏航**） | 取成 `attitude_head`（机头朝向）→ 航线合法、飞完全程、每点也确实转了头，只是相机偏了那几十度，拍的是马路对面 |

★ 平台与库这两侧都**拦不住**（值都合法），故只写在 `append-waypoint.ts` 的实现注释、
`schema.sql` 的列注释与这张表里。

### 其余口径

- **七元组全部必填**，判「缺失」**绝不许用零值**：`gimbal_pitch` 常年是负数、
  `camera_yaw` 的合法区间含 **0**（相机朝正北）。`ai_recognition_on` 必须是**真布尔**
  （不认 `"true"` / `1`）——「不传」与「传了 false」必须分得开。
- `ai_target_types` 归一化 = 白名单（`person` / `car` / `boat`）+ 去重 + **排序**；
  白名单外的值**静默丢弃但打一条 `log.warn`**（那是发现「座舱上线了新类型」的唯一途径）；
  ⚠️ 但 `ai_recognition_on === true` 而一个合法类型都不剩时**当场拒**——
  否则会生成一条「面板显示 AI 已开、飞完一个目标都不报」的航线。
- 与原生实现的偏差（含「不 touch 航线 `updated_at`」、回不了 `screenshot_url`）
  逐条写在 `handlers/teach/append-waypoint.ts` 的实现注释里。
- ⚠️ 日志与错误文案里**一个坐标都不记**（巡逻点位置）。

### ⚠️ 航点表的两处「平台表达不出来」

| 原生实现 | 插件这一路 |
| --- | --- |
| `UNIQUE (route_id, seq)` | 同样是**真的复合唯一索引** —— `createIfAbsent` 的 `uniqueBy` 支持多列，故**不必**像航线表那样造合成锁列。⚠️ 但清单 `entities[]` 的 `unique` 只挂在单字段上，表达不出复合，故那两个字段在清单里只写 `indexed`（反正 `entities[]` 只做展示） |
| 六个 `DOUBLE PRECISION` 列 | 退成 TEXT ⇒ **库那侧不再保证这些列里是个数**，值域校验全部落在 `append-waypoint.ts` 里 |

★ 外键 `teach_route_id REFERENCES plugin_db_teach_route(id) ON DELETE CASCADE` 是**刻意加的**：
插件这一路没有事务，「删航线要连点一起删」只能由库保证——靠脚本先删点再删航线的话，
中间挂掉就留下一批**永远查不到、也永远删不掉**的孤儿点。
⚠️ 代价：给一条已被删掉的航线追加航点时 PG 回 `23503`，平台收敛成 `STORAGE_ERROR`
（按可重试处理，而它其实重试不好）。那个窗口很窄，且日志里有 `sqlstate=23503` 那句提示。

## 二之五、改航点 / 删航点 / 删航线怎么落的

这三个入口共用两张表，也共用同一批坑。逐条记在这里，因为**它们写坏了都不报错**。

### ★ 删航线：点由外键级联删，脚本不碰

`plugin_db_teach_waypoint.teach_route_id` 上带 `ON DELETE CASCADE`，删航线那一行点自己就走了。
⚠️ **不许自己先删点**：插件这一路没有事务，自己删就是两次写——删点成功、删航线那步炸掉，
库里留下一条「0 个点的航线」，用户看到一条被掏空的录制，而重试能修但没人知道要重试。

⚠️⚠️ 级联的代价是**它是静默的**，于是两件事做不了：

| 原生实现靠什么 | 插件这一路 |
| --- | --- |
| `DELETE … RETURNING screenshot_key`，把孤儿截图的 key 记进日志供对象存储回收对账 | **拿不到**。要拿只能先分页读全部航点（1000 行上限 vs 一次录制约 1800 点） |
| 删除本身回的行数就是 `deleted_waypoints` | 只能**删之前 `count` 一次**。⚠️ 数完到删掉之间有人在加点的话会差一两个——纯展示误差，库里不会不一致 |

⚠️⚠️ `count` **必须在 delete 之前**。挪到之后恒回 0（点已经被级联带走了）——
于是用户删掉一条录了两百个点的航线，界面提示「已删除 0 个航点」，而这一路全程 200。
★ 门禁：直接断言调用顺序（本包 `tests/`）。

★ **被删航点上的截图 key 收不到**（脚本头有这句话）：级联删拿不到 `RETURNING`，
要拿只能先分页读全部航点。`delete-route.ts` 里那条「名下截图未对账」的 warn
是对账的信号。

### ⚠️⚠️ 删航点

- `screenshot_key` 非空时记进日志供对象存储对账（与原生同款），对象存储上的文件**不删**。
- `teach_route.screenshot_bytes` 不再维护（恒为 `"0"`）。
- 存在性判据是 `store.delete` 回的 `deleted` 行数，**不是先查再判**。
  查到的航点信息（`teach_route_id`、`screenshot_key`）用于出参和 orphan 日志。

### ⚠️⚠️ 改航点：只写传了的字段

可改的只有 `focal_length` 与 `selected` 两个，且**至少要传一个**。

- **没传的字段绝不能进 record**。把 `focal_length: undefined` 也塞进去会把用户没碰过的
  焦距覆盖掉——生成时那个点的视野全错，而录制、生成、上传、起飞每一环都是 200，
  只有真飞一遍才发现车牌拍不清。
- **一个都没传要当场拒**，不许退化成发一条空 update：平台收到空 record 回的是
  `TYPE_MISMATCH`，那句话说的是「类型不对」，而真正的问题是「你什么都没改」。
- `selected` **必须是真布尔**（与 `ai_recognition_on` 同一理由）：落库是 `"true"` / `"false"`
  两个字面量，而 JS 里 **`"false"` 是真值**——一旦放宽到字符串，读侧任何一处忘了显式比对
  `=== "true"`，取消勾选就静默失效（那个点仍然参与生成）。
- **焦距原样存、原样用，不吸附到档位**。飞手在现场看着实时画面调到 48mm，确认
  「这个视野正好框住路边车位」；吸到 24mm 车牌小到认不出，吸到 70mm 车位被切掉一半。
- **存在性只看 `affected`**，不先查一遍。先查再写的话两者之间那个点可能刚好被删，
  于是「查到了、写了 0 行」而脚本已经决定回 200 了——那种错本地单线程永远跑不出来。
- 出参与 `teach.append-waypoint` **同形**，前端一套解析走两处。
  ⚠️ 要回完整航点只能 update 之后再查一次（平台的 update 只回行数）；
  那一查回的是**此刻库里的值**，并发下不一定是本次写进去的那份。

### ⚠️ 三个入口都不 touch 航线的 `updated_at`

原生实现 `UpdateWaypoint` / `DeleteWaypoint` 都顺手 touch 了一次，喂的是**24 小时清理作业**
（「用户可能花二十分钟逐点调焦距而不加新点，不 touch 的话正在编辑的录制会被扫掉」）。
★ 插件这一路**没有那个作业**，没有谁依赖那个时间戳。

⚠️⚠️ **哪天要加那个清理，必须先回头给三个航点入口都补上 touch**，否则正在逐点调焦距的
录制会被扫掉，而用户什么提示都收不到。★ 现有门禁断言「不许写航线行」——
那条红了就是提醒。
⚠️ 删航点**不会**顺带刷 `updated_at`（删航点只删航点行，不触发航线行的 update）。

### ★ 删点不重排 seq

删掉第 5 个点之后第 6 个仍然是 6，中间留空洞——与原生一致。
重排要更新后面所有行（无事务，改一半就乱套），还会让前端已渲染的列表 key 全部失效。
⚠️ 读侧**不许拿数组下标当 seq 用**；追加航点靠「当前最大 seq + 1」分配，不受空洞影响
（用 `count` 会撞上仍然存在的号——那条已经写死在 `append-waypoint.ts` 里）。

★ 也**不拦**「删到只剩 0 / 1 个选中点」：数量校验是生成时的事，录制期拦会挡住
「先删光再重录」这种正常操作。

## 二之六、生成航线：本包唯一一个调 hostCapability 的入口

`teach.generate-wayline`（`handlers/teach/generate-wayline.ts`）与其余九个入口有**三处结构性
不同**。三处都不是风格差异，是从「这个入口不可逆」推出来的。

### ① 它调能力面（其余九个只碰 `data:read` / `data:write`）

清单的 `allowlist` 里因此多一项 **`wayline:generate`**。

★ **为什么生成 KMZ 不能写在 JS 里**，三条，一条都绕不开：

1. 要查 **2 MB 的 EGM96 大地水准面网格**做椭球高 → 海拔高换算——`template.kml` 与
   `waylines.wpml` 两份文件的高度口径**不同**（`executeHeightMode=WGS84` 椭球高
   vs `heightMode=EGM96` 海拔高，`H = h − N`）。那张网格是宿主侧内置的
   二进制大对象，插件沙箱里既没有它也读不了文件。
2. 要拼两份高度口径不同、**同名字段填不同值**的 XML，再打成 zip。沙箱里没有 zip。
3. 落地那一步要拿 **STS 临时凭据**往对象存储写字节——而**插件 JS 是明文分发的**，
   凭据一个字都不能进这一侧（平台媒体能力契约的禁令：
   bucket 名 / STS 或访问凭据 / object key 的拼法 / 用户 token，四样刻意都不在契约里）。

🔒 故 `wayline.generate` 的出参里**只有 id 类字段**：`waylineUuid` / `objectKey` /
`name` / `waypointCount`。没有 bucket、没有签名 URL、没有凭据——这份 JS 拼不出任何
可访问的地址，也不需要。

⚠️⚠️ 入参那一侧有一个**不报错的错法**：键名是 **camelCase**（`gimbalPitch` /
`cameraYaw` / `focalLength` / `aiRecognitionOn` / `aiTargetTypes`），与库里的
snake_case 列名**不同**。写成 snake_case 的表现是**那个字段恒为 0 / false**——
取不到的键在能力面那侧按零值走，于是云台恒平视、AI 恒关，而航线照样生成、照样能飞。
★ 这是整条链上最难发现的一种错法，改 `toCapabilityWaypoints` 时逐个字段核对。

### ② 它不可逆，于是三条取舍与其余入口**相反**

成功返回 = 航点**已经被删光**、航线**已经是 `generated` 终态**。用户没有第二次机会。

| | 其余入口 | 这一个 |
| --- | --- | --- |
| 航点撞上分页上限（5 页 × 1000） | **截断** + `waypoints_truncated: true` | **报错** |
| A7（开着 AI 却没有合法目标类型） | append 时拦一道 | **再拦一道** |
| 落库失败而上游已写成功 | 不存在这种局面 | **不做补偿删除**，记日志对账 |

- **截断必须变报错**：降级在这里的表现是「烧出一条少了一截的航线」而全程 200——
  飞机会按那条短航线飞完然后返航，**没有任何人知道后半段丢了**。★ 报错则航点还在、
  航线仍是 `recording`，用户能取消勾选一部分再生成。
- **A7 二道闸**拦的是那道校验**上线之前**就落库的历史行。
  少了这道，历史数据会照样烧出一条「AI 已开、却没有任何 `targetDetection`」的航线。
  ★ 报 `seq` 不报 id：面板上航点是按 seq 排的，用户能直接对上第几个点。
- **孤儿航线不删**：抢占失败时上游那条航线成了孤儿（文件服务里有、本库里没有引用）。
  删航线要调下游删除接口，删失败又得处理，而**多一条同名航线的代价远小于删错**。
  ★ 故 `orphan_wayline_uuid` / `orphan_object_key` / `orphan_wayline_name` 要记进
  `log.warn`——**那条日志是这两个孤儿资产唯一的落脚点，别精简掉**。

### ③ 它没有事务（原生实现「置终态 + 删航点」是一个事务）

★ **抢占仍然是安全的**：判据是 update 的 filter 里带 `status=recording` 加上 `affected`
行数（与 `update-route.ts` 同一条纪律），不是「先查再写」。

⚠️ 真正的偏差在**中间断电**：置了终态而航点没删掉。表现是一条 `generated` 的航线名下
还挂着点——只是**脏数据**，不影响航线本身（航线内容已经烧进 KMZ 了），且那些点再也
不会被任何入口用到（其余入口都判 `status=recording`）。

★ 故删航点那一步**失败不回错，只 warn**：回错会让用户以为航线没生成而重试，而重试
必然撞上「已生成」——那才是真正说不清的状态。

### ⚠️ 另外两处与原生实现的偏差

- **`project_id` 为空时没有租户兜底**——插件 ctx 里没有租户（只有 `now` / `pluginVersion` /
  `scriptId` / `requestId` / `idempotencyKey` / `stableId` 六项）。空串照样递给能力面，
  由 host 侧用进程级 workspace 兜底；两边都空时 host 报错。★ 那句话说得出
  「配置里 `workspace_id` 也没配」，比在 JS 里编一句准。
- **收不到被删航点的 `screenshot_key`**：原生那条 `DELETE … RETURNING` 在平台的
  `delete` 上没有对应物（平台 delete 只回行数）。哪天要对账，
  要连 `delete-route.ts` 那条一起补。

### ⚠️ `wayline_file_id` 恒为空串

设计文档写的是文件登记的 `FileID`，但那是另一套文件服务客户端的返回；本仓
航线文件登记回调的上游响应体只有 `{key, name, uuid}`，**没有 `file_id`**。

★ **不拿 uuid 去顶这个字段**——那是一个会被后来人当真的假值，真要按 `file_id` 去文件
服务查的时候才会发现查不到。列先留着，等上游真回了再填。

### ⚠️ 日志里一个坐标都不记

全包纪律（不留巡逻点位置）。★ 但航线名、两个速度、`wayline_uuid`、`object_key` 都要
记：它们是这次操作的**结果**，而「航线生成了但任务规划页选不到」这类报障的第一个判据
就是那两个 id——有 uuid 说明登记成功了，问题在下游那个下拉的 `file_source` 过滤；
没有则查本条链路。

## 二之七、handler 命名约定

**动词开头**，与 `official_traffic_capture` 的 `h_` 入口同一条规则。截图两条已落地：

| 原生 HTTP 路由 | handler 名 |
| --- | --- |
| `POST /routes/:id/screenshot-sts` | `h_teach_createScreenshotSTS` |
| `POST /waypoints/:id/screenshot` | `h_teach_attachScreenshot` |

两条都是 JS Handler（`handlers/teach/` 下）；`createScreenshotSTS` 申了
`screenshot:issueupload` 能力（查库 + 取 STS 在 Host 侧），`attachScreenshot` 纯 CRUD。

## 三、发布与建表纪律（面向插件作者）

1. `plugin_db_teach_route` 与 `plugin_db_teach_waypoint` 由**平台内置迁移**建，
   插件作者不手工跑 `schema.sql`；本包的 `schema.sql` 是**对照件**，改它就必须同步
   改平台侧建表语句，有门禁逐语句比对（两张表的语句一起比）。
   ⚠️⚠️ 航点表是【单独一条】迁移，不是追加进航线表那条。迁移框架按 ID 记
   「这条跑过了」，往已跑过的迁移里追加语句**永远不会再执行**——表现是新起的库
   有航点表、已经上线的那套没有，而启动日志一切正常。★ 以后加表照这个办：**新开一条 ID**。
2. 表建没建，看启动日志：`插件业务表自检通过` / `⚠️⚠️⚠️ 插件业务表自检:N/M 个实体不可用`。
   具体缺什么看 datastore 日志的 `sqlstate=`：`42P01` 表不存在 / `42P10` 缺唯一索引 /
   `42703` 列名不一致。
3. 再升进程、再发插件包。清单解析是严格模式——旧进程碰上新字段会**整包拒装**。
4. 新增脚本要落在 `handlers/<组>/<入口>.ts` 两层里：直接放在 `handlers/`
   根下的文件**不会被装配进包**。
5. ⚠️ 新脚本里复制过来的助手（`storeErr` / `requireText` …）必须与本包已有那份
   **逐字节一致**，门禁在 `tests/`。改助手就改全部。
6. ⚠️⚠️ 本包的 `allowlist` 现在有 **`wayline:generate`**（`generate-wayline` 那一个入口用）。
   ★ 加/删能力要同时动**两处**：插件清单 `fh2-plugin.json` 的 `allowlist` 与
   平台宿主的注入面。⚠️ 漏了清单那一处的表现最费解：平台**不报**「能力未授权」，
   它只是不把 `wayline` 注进沙箱 ⇒ 运行期 TypeError ⇒ 落**可重试**档 ⇒
   表现是「点生成转三次圈然后失败」。
7. ⚠️⚠️ `wayline:generate` 要下游文件存储能力在线才接得上真货（取 STS 与
   航线文件登记回调）。★ 这一对配置**要么都配、要么都不配**。⚠️ 这个空壳与
   media / duplex 那两个不同：它**调用即回错**，不回 `skipped`——「航线没生成」
   不是少做一件事，是造出一个假答案。
   ⚠️ 这两条也是本插件**仅有的要用户 token 的下游**（路径里有 `{workspace}`、看登录态），
   token 由前端经 `x-auth-token` 逐次传进来，不进配置。
