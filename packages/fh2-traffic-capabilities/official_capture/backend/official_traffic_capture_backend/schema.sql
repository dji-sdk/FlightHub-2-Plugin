-- SPDX-License-Identifier: Apache-2.0
-- Copyright (c) 2026 SZ DJI Technology Co., Ltd.
-- official_traffic_capture 插件的建表脚本（变道抓拍 + 行人违章上路）
--
-- 【执行位置】本插件不单独建库，复用部署方提供的业务库；DDL 由部署方在目标库执行。
--   跑错库的表现：服务能启动、接口返回 200，但所有存储调用报“表不存在”。
--
-- 【表名】平台给业务表加 plugin_db_ 前缀：清单实体 lane_change_event 对应
--   plugin_db_lane_change_event。清单里的实体名与物理表名不必逐字一致。
--   平台不建表、不改表，也不按 entities[] 校验；表或列缺失由数据库报错，
--   插件侧收敛为 STORAGE_ERROR。
--
-- 【保留列】平台注入 id / created_at / updated_at，并保留 tenant_id；
--   插件不得自己声明同名字段。
--
-- 【项目隔离】平台不注入也不校验 project_id。每张业务表自带 project_id，
--   且每次 query/update/count 的 filter 都必须带上它；漏带会跨项目串数据且不报错。
--
-- 【字段类型】业务字段统一 TEXT：存储层当前只接受字符串，读回也是字符串。
--
-- 【命名】列名统一 snake_case，并在插件脚本里使用同一名字，避免读取时出现空值。

BEGIN;
CREATE TABLE IF NOT EXISTS plugin_db_lane_change_mode (
    id            TEXT PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL,
    tenant_id     TEXT NULL,          -- ⚠️ 平台保留列,一期不写(归属隔离已定不做)

    mode_key      TEXT NOT NULL,
    project_id    TEXT NULL,
    dock_sn       TEXT NULL,
    flight_id     TEXT NULL,
    is_active     TEXT NULL,          -- "1" / "0"。⚠️ TEXT 而不是 boolean,理由见文件头
    started_at_ms TEXT NULL,
    stopped_at_ms TEXT NULL
);

-- ⚠️⚠️ 这条唯一索引【必须真建】:插件靠 createIfAbsent 做"同一个机场只有一行记账",
--   而那个动作走 ON CONFLICT (mode_key) —— 没有这条索引 PostgreSQL 会**直接拒**那条语句
--   (报 no unique or exclusion constraint matching)。
--   ★ 那是要的:静默退化成 insert 的表现是"偶尔多出一行",只在并发窗口里发生、复现不了。
CREATE UNIQUE INDEX IF NOT EXISTS uq_lane_change_mode_key
    ON plugin_db_lane_change_mode (mode_key);
CREATE INDEX IF NOT EXISTS ix_lane_change_mode_project_dock
    ON plugin_db_lane_change_mode (project_id, dock_sn);

-- ── 变道事件 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plugin_db_lane_change_event (
    id               TEXT PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL,
    tenant_id        TEXT NULL,

    event_key        TEXT NOT NULL,
    project_id       TEXT NULL,
    dock_sn          TEXT NULL,
    flight_id        TEXT NULL,
    obj_id           TEXT NULL,
    region_id        TEXT NULL,
    annotation_id    TEXT NULL,
    collision_type   TEXT NULL,       -- solid_line / guide_area
    post_status      TEXT NULL,       -- pending_video / waiting_artifacts / processing / verified / rejected / failed
    crossed_at_ms    TEXT NULL,       -- ⚠️ 定宽 13 位;排序与时间窗匹配靠它
    snapshot_json    TEXT NULL,       -- ⚠️ 标注快照的 JSON 原文(含 geo_points)
    video_file_id    TEXT NULL,
    video_object_key TEXT NULL,
    -- ★★ 录制锚点:sidecar 里只有帧号,把帧号换成墙钟要靠它 —— 而平台从 file id 拿不到
    -- (文件服务 没有那个 inner 接口)。由视频回调消息透传进来并存下。
    --
    -- ⚠️⚠️ 两者【不同权】,别当成一对普通的起止:
    --   video_start_ms   **权威**。= 上游 video_create_time_ms(mp4 creation_time),
    --                    已定按"录制开始"处理。作业靠它换算,缺了就做不了。
    --   video_end_ms     **仅供展示与排查**。= 锚点 + 上游 duration_sec,而那个值在
    --                    动图分支恒为 0 → 那时这一列是空串。
    --                    ⚠️ 作业【不读它】:窗口宽度由 video.probe 读真实文件得出,
    --                      因为宽度错了 fps 估算跟着错(见 objecttrack.Inspect)。
    video_start_ms   TEXT NULL,
    video_end_ms     TEXT NULL,
    -- ★ 上游那个**没规范化**的时间串(ffprobe format.tags.creation_time 原文)。
    -- ⚠️⚠️ 存它是一层**时区对冲**:那个串的时区语义至今没有定论(相机常写本地时间却带
    --   Z 后缀,文件服务 自己的注释就是这么写的)。若 video_start_ms 偏了 8 小时,
    --   表现是**所有时间窗匹配集体落空而没有任何地方看得出来** —— 有这一列,
    --   我们自己重解就能自救,不必等 文件服务 改版。
    video_create_raw TEXT NULL,
    reject_reason    TEXT NULL,
    failure_reason   TEXT NULL,
    -- ★★ 证据归档目录(一个违章一个目录):
    --   folder_id        = 本次违章自己的证据目录 id(四份证据都移进这里)。
    --   parent_folder_id = 上级目录 id(两跳反查出来的架次目录 = 证据文件的爷爷)。
    -- ⚠️ folder_id 非空 = 已归档过 —— 作业重投时靠它跳过,不重复建目录/移动
    --   (条件写 folder_id IS NULL,无事务无锁下的 claim,判据同 illegal_road_tracking)。
    folder_id        TEXT NULL,
    parent_folder_id TEXT NULL
);

-- ⚠️⚠️⚠️ 这条是【整个插件最要紧的一条约束】:前端在弱网下会用同一个 event_key 重试,
--   而幂等完全靠 createIfAbsent + 这条唯一索引。漏了它的表现**不是报错**,是
--   "同一次变道产生了两条事件"(提案 §16.5)—— 到发现时数据已经脏了。
CREATE UNIQUE INDEX IF NOT EXISTS uq_lane_change_event_key
    ON plugin_db_lane_change_event (event_key);

-- 列表查询:project(+flight/collision/status)等值筛 + 按 crossed_at_ms 倒序。
-- ★ 把 crossed_at_ms 放在末列,让它同时服务筛选与排序。
CREATE INDEX IF NOT EXISTS ix_lane_change_event_list
    ON plugin_db_lane_change_event (project_id, flight_id, crossed_at_ms DESC);
CREATE INDEX IF NOT EXISTS ix_lane_change_event_status
    ON plugin_db_lane_change_event (project_id, post_status, crossed_at_ms DESC);

-- 视频回调匹配:同机场 + 同架次 + 还在等视频 + 时间窗。
-- ⚠️ 这条不是"顺手加的":那次查询在每条视频回调上都会跑,而它是全表里唯一带范围的查询。
-- ★ flight_id 排在 dock_sn 之后、post_status 之前 —— 判据来自现网那条查询
--   (dock_sn = ? AND flight_id = ? 都是等值筛)。
--   ⓘ 上游 flight_id 为空串时那次查询不带这个条件,索引仍可用(前缀 dock_sn 命中)。
CREATE INDEX IF NOT EXISTS ix_lane_change_event_match
    ON plugin_db_lane_change_event (dock_sn, flight_id, post_status, crossed_at_ms);

-- ── 证据 ────────────────────────────────────────────────────────────────────
--
-- ★ evidence_key = event_id + ":" + role(理由同 mode_key:复合唯一表达不出来)。
CREATE TABLE IF NOT EXISTS plugin_db_lane_change_evidence (
    id           TEXT PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL,
    tenant_id    TEXT NULL,

    evidence_key TEXT NOT NULL,
    event_id     TEXT NULL,
    role         TEXT NULL,           -- before / violation / after / clip
    file_id      TEXT NULL,           -- ⚠️ 前端契约里是 number,插件出参时转
    at_ms        TEXT NULL
);

-- ⚠️⚠️ 必须真建:后处理作业会被平台工作流引擎重试,而重跑一遍抽帧会再写一份证据 ——
--   靠 createIfAbsent + 这条索引保证"同一事件同一角色只有一条"。
CREATE UNIQUE INDEX IF NOT EXISTS uq_lane_change_evidence_key
    ON plugin_db_lane_change_evidence (evidence_key);
CREATE INDEX IF NOT EXISTS ix_lane_change_evidence_event
    ON plugin_db_lane_change_evidence (event_id, role);

-- ════════════════════════════════════════════════════════════════════════════
-- 行人违章上路(非机动车上路抓拍)—— 三张表
--
-- ⚠️⚠️⚠️ 【每张表都必须有 project_id,且每一次 query/update/count 的 filter 都要带上它】。
--   平台的**项目归属校验没有实现**(能力缺口表第 2 条)—— 也就是说 filter 里漏掉
--   project_id 时,平台**一个字都不报**,接口照样 200,只是把别的项目的数据也捞进来了。
--   ★ 这是本插件唯一一条"漏写一个键就跨项目串数据、且完全静默"的风险,故在每张表的
--   列注释里都再点一次。判据:docs/行人上路Handler联调-review-report.md §C0。
--
-- ★ 三张表的关系:session 1 ── n tracking 1 ── n media。
--   session = 一次"机场 × 抓拍任务"的会话;tracking = 会话下的一次跟踪(一个目标从
--   发现到消失);media = tracking 与媒体文件的关联(本期只有照片,视频在 3.2.4)。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 行人上路:抓拍会话 ────────────────────────────────────────────────────────
--
-- ★ session_key = sessionKeyOf(project_id, flight_id, salt)
--     = project_id + ":" + flight_id + ":" + salt。
--   salt = ctx.idempotencyKey(前端带了那个头时)否则 = 本次 started_at_ms。
--
-- ⚠️⚠️⚠️ 【2026-09-12 改:一个架次可以有多个会话(方案 B,前端已确认)】。
--   旧设计是 session_key = project:flight,依据"一次架次天然只有一个会话" ——
--   **那句话是错的**,判据两条:
--   ① 外部参照实现没有会话实体,只用设备开关键维护状态(不含架次维度),覆盖写、
--      **没有终态**,同一架次可无限次重开;
--   ② 前端确认:同一架次会先后开多次抓拍(关掉再开),而 stopped 是终态。
--   ★ 旧设计下重开同架次的表现是:createIfAbsent 命中那条**已 stopped** 的旧记录并原样回,
--     于是 start-session 回 is_active=false —— 前端联调 2026-09-12 遇到的正是这个
--     (flight 8d7cd0c3 开会话回 false)。加 salt 之后重开必生成**新的 active 行**。
--
-- ⚠️⚠️ 【为什么不像 lane_change_mode 那样用 project+dock】:那张表表达的是
--   "模式开关",同一个机场**恒一条**;而这张表是"会话记录",同一个机场先后会有多次
--   (今天上午一次架次、下午另一次架次)。用 project+dock 做唯一键会把不同架次的会话
--   **并到一条上**,表现是"重新开始抓拍后,页面上的已抓拍时长接着上一次算"。
--
-- ⚠️⚠️ 【幂等靠 salt,不靠 Idempotency-Key 必填】。带了那个头就真幂等(重试回同一条,
--   契约 §3.1「重复提交返回同一 Session」);没带就退化成"同一毫秒内的重复提交才合并" ——
--   这是刻意的取舍:协议 §0.8/§1.1 明写本接口不该要求那个头(前端联调 §8.2/§8.3 就卡在
--   旧的 ctx.stableId 派生上,缺头直接抛 40006)。
--   ★ 退化路径下多开出来的那条会话不会造成脏活动态:新会话会把同架次的旧 active 会话
--     **连同它名下还 open 的 Tracking 一起收尾**(见 start-session.js)。
--
-- ⚠️ 判据:handlers/illegal-road/start-session.js 的 sessionKeyOf。
CREATE TABLE IF NOT EXISTS plugin_db_illegal_road_session (
    id            TEXT PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL,
    tenant_id     TEXT NULL,          -- ⚠️ 平台保留列,一期不写

    session_key   TEXT NOT NULL,
    project_id    TEXT NULL,          -- ⚠️ 归属隔离靠它,见本段头部
    dock_sn       TEXT NULL,
    flight_id     TEXT NULL,
    status        TEXT NULL,          -- active / stopped / failed。⚠️ 契约 §5 的值域,只有这三个
    started_at_ms TEXT NULL,          -- ⚠️ 定宽 13 位补零,理由见文件头
    stopped_at_ms TEXT NULL           -- 未结束时是空串 ""(不是 NULL —— 平台只写得进字符串)
);

-- ⚠️⚠️ 必须真建:createIfAbsent 的 ON CONFLICT (session_key) 没有索引时 PostgreSQL
--   会**直接拒**整条语句。
-- ⓘ 2026-09-12(方案 B):这条索引的【结构一个字没改】,改的只是写进 session_key 的**取值**
--   (加了 salt,见上)。索引名与列都没变 → **不需要升级段的 DROP/CREATE**
--   (那种处理只在"名字没变而列变了"时才必要,见下面 ② ④ 两条)。
-- ★ 它现在守的是"同一次点击(同一幂等键/同一毫秒)只开出一条会话",
--   而不再是"同一架次只有一条会话"。
CREATE UNIQUE INDEX IF NOT EXISTS uq_illegal_road_session_key
    ON plugin_db_illegal_road_session (session_key);
-- get-status:project + dock + status=active,取 started_at_ms 最大的一条。
-- ★ started_at_ms 放末列,让它同时服务筛选与排序。
-- ⚠️ 方案 B 之后同架次会**累积多条历史会话**(只有最后一条是 active),这条索引因此
--   比从前更要紧:读侧全部是"取最新一条 active",没有它会随会话数增长而退化成扫表。
CREATE INDEX IF NOT EXISTS ix_illegal_road_session_status
    ON plugin_db_illegal_road_session (project_id, dock_sn, status, started_at_ms DESC);

-- ★ 方案 B 新增:start-session 要按 (project, flight, status) 找"同架次那条还 active 的会话"
--   来收尾,而上面那条索引的第二列是 dock_sn(入参里有 dock_sn,但收尾要认的是**架次**)。
-- ⚠️ 不建它的表现是**功能全对**,只是每次开会话都要按 project 扫一遍会话表 ——
--   没有任何地方报警,而会话表是只增不减的。
CREATE INDEX IF NOT EXISTS ix_illegal_road_session_flight
    ON plugin_db_illegal_road_session (project_id, flight_id, status, started_at_ms DESC);

-- ── 行人上路:跟踪 ────────────────────────────────────────────────────────────
--
-- ★ tracking_key = trackingKeyOf(project_id, session_id, salt) —— 业务自然键,见
--   handlers/illegal-road/start-tracking.js 的 trackingKeyOf。
--   ⚠️ 【2026-09-12 从 ctx.stableId 换过来的】,理由与 session_key 那段同源:stableId 在缺
--     Idempotency-Key 头时直接抛 40006,而前端确认不带那个头也要能用。
--   ★ salt = Idempotency-Key(带头时,真幂等)或 started_at_ms(不带头时,同毫秒才合并)。
--   ⓘ 索引结构**没变**(仍是 tracking_key 单列唯一),只是写进这一列的**值**变了 ——
--     故不需要 DROP/CREATE 迁移。⚠️ 但换键当天已有的旧行,其 tracking_key 是老的
--     32 位 hex 形态,与新键不同形:它们不会再被任何新请求命中(新请求算出的是新形态的键),
--     表现是"换键前那几条旧记录不再参与去重" —— 一次性且无害,不用清洗。
--
-- ⚠️⚠️ 【没有 target_type 列】(行人 / 非机动车)。初稿设计过,核对前端契约后删掉:
--   §3.4 的入参只有 session_id 与 started_at,§3.6 的出参里也没有这个字段 ——
--   **前端既不传、也不读**。留一个没人写没人读的列,只会让下一个人以为它有意义。
--   ★ 同一逻辑:需求方 2026-09-10 已定「不区分远景图 / 近景图」。
--
-- ★ close_reason 记这条 Tracking 是**被哪条途径关掉的**。现有值域(2026-09-12):
--     manual             用户逐条调 stop-tracking 关的
--     superseded         同会话内被下一条 Tracking 顶掉的(start-tracking 第 3 步)
--     session_stopped    用户调 stop-session 收尾会话时一并关的
--     session_superseded 同架次开了新会话,旧会话被顶掉时一并关的(方案 B,start-session)
--   ⚠️ 几条途径在数据上**完全同形**,不留这一列的话,出问题时无法区分
--   「前端没调 stop-tracking」和「stop 调了但没生效」。成本一个 TEXT。
--   ⓘ 【它从"内部诊断列"转正成了契约字段】(A-3,2026-09-11):list-trackings 的列表项
--     会回它,前端据此解释"这一轮为什么只有 1 张图"。★ 故这四个值改名/新增都要同步前端。
--     ⚠️ session_superseded 是方案 B 新加的第四个值,已列入协议 §2.3 待改项。
--   ⓘ 一期**不会**出现 auto_timeout 那个值(见下面 ended_at_ms 那段):兜底自动关闭那套
--     写路径已整个删掉,取而代之的是建行时预写 ended_at_ms。
CREATE TABLE IF NOT EXISTS plugin_db_illegal_road_tracking (
    id            TEXT PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL,
    tenant_id     TEXT NULL,

    tracking_key  TEXT NOT NULL,
    session_id    TEXT NULL,          -- = session 表平台注入的 id
    project_id    TEXT NULL,          -- ⚠️ 冗余一份:为的是**不 join 也能带归属筛选**
    dock_sn       TEXT NULL,          -- 冗余:列表页要显示,照片事件也按它匹配
    flight_id     TEXT NULL,          -- 冗余:契约 §3.6 要按它筛、也要回显
    status        TEXT NULL,          -- open / closed。⚠️ 契约 §5,只有这两个
    started_at_ms TEXT NULL,          -- ⚠️ 前端传的值(契约 §3.4),13 位补零
    -- ⚠️⚠️⚠️ 【status='open' 时这一列是「预估上限」,不是真值】。
    --   建行时就写成 started_at + 30s(判据:福田 config.tmpl.yaml:65 max_tracking_duration_sec=30
    --   + 需求方 2026-09-10「定 30 秒」),stop-tracking 只把它**改小**到真实值。
    --   ★ 这样做的收益:照片匹配退化成一个干净的闭区间比较
    --     (started_at_ms <= 拍摄时刻 AND ended_at_ms > 拍摄时刻),
    --     不再需要福田那条 "(ended_at>0 AND ...) OR (ended_at=0 AND started_at+30s>...)" 的复合条件,
    --     也不再需要任何"兜底自动关闭"的写路径(那套 autoCloseStale 已删)。
    --   ⚠️⚠️ 代价必须记住:**一条 open 记录的 ended_at_ms 不是它真的结束了**。
    --     所以 list-trackings 组装出参时,status='open' 的行 ended_at 必须回 0 ——
    --     直接把这个预估值吐给前端的表现是:一次正在进行的抓拍显示成"已结束,时长 30 秒"。
    ended_at_ms   TEXT NULL,
    close_reason  TEXT NULL,          -- manual。⚠️ 不进出参,见本段头部

    -- 归档目录(单元 04:照抄福田「建目录 + 把媒体移进去」)。两者都是目录 id 的字符串形态。
    --   folder_id        = 本架次自己的证据目录 id(媒体文件移进这里)。
    --   parent_folder_id = 上级目录 id(两跳反查出来的架次目录 = file 的爷爷)。
    -- ⚠️ 只是目录 id、不带任何凭据,可落库、可进日志 —— 与媒体链接字段不同。
    -- ⚠️ 由**媒体事件消费方**回填(异步),不是建行时就有;归档失败时保持 NULL,
    --   list-trackings/list-media 要容忍空值(前端在 03b 落地前也要容忍 0)。
    folder_id         TEXT NULL,
    parent_folder_id  TEXT NULL
);


CREATE UNIQUE INDEX IF NOT EXISTS uq_illegal_road_tracking_key
    ON plugin_db_illegal_road_tracking (tracking_key);
-- list-trackings:project(+flight)筛 + started_at_ms 倒序。
CREATE INDEX IF NOT EXISTS ix_illegal_road_tracking_list
    ON plugin_db_illegal_road_tracking (project_id, flight_id, started_at_ms DESC);
-- stop-session / start-tracking:关掉某会话下所有 open 的跟踪。
CREATE INDEX IF NOT EXISTS ix_illegal_road_tracking_session
    ON plugin_db_illegal_road_tracking (project_id, session_id, status);
-- ⚠️⚠️ 照片事件的匹配查询。它在**每一条照片消息**上都会跑(照片量远大于事件量),
--   所以不是"顺手加的"。
--   ★ 2026-09-11 修正:此前这条索引没有 project_id,理由写的是「MQ 消息里没有 project_id,
--     只能按 dock_sn 反查」—— **那句话是错的**。媒体处理完成事件里带着
--     workspace_id(项目 uuid),消费方直接拿它当 project_id 用,不需要反查。
--   ★ 末两列都是范围列:started_at_ms <= 拍摄时刻 AND ended_at_ms > 拍摄时刻。
--     status 不再进索引 —— 预写 ended_at_ms 之后 open/closed 在匹配上是同一套条件。
--   ⚠️ 索引名没变而列变了 → 已经建过表的库要靠文件末尾【升级段④】换掉它。
CREATE INDEX IF NOT EXISTS ix_illegal_road_tracking_match
    ON plugin_db_illegal_road_tracking (project_id, dock_sn, started_at_ms, ended_at_ms);
-- 撞名消歧:按 folder_id 反查"这个目录是不是已被别的 tracking 占用"
-- (见 events 那侧的 isFolderOwnedByOtherTracking)。
-- ★ 2026-09-13 起目录名不再恒带 trackingId 后缀,这条查询才出现;它只在撞名这个
--   罕见路径上跑,但 tracking 表只增不减,没索引时真撞上要全表扫。
-- ⓘ 部分索引:folder_id 绝大多数时候为空(异步回填),排除空值能让索引小一个量级。
-- ⚠️ 已经建过表的库要靠文件末尾【升级段⑧】补它。
CREATE INDEX IF NOT EXISTS ix_illegal_road_tracking_folder
    ON plugin_db_illegal_road_tracking (folder_id)
    WHERE folder_id IS NOT NULL;

-- ── 行人上路:媒体关联 ────────────────────────────────────────────────────────
--
-- ★★ media_key = tracking_id + ":" + file_id,**不用 stableId**。
--   这条记录由**事件**创建,而事件路的幂等键是投递侧给的 event_id —— 同一个文件被重投时
--   那个 id 是否稳定,本仓查不到权威说法。而 tracking_id + file_id 在**业务上天然唯一**
--   (一个文件不可能属于同一个 Tracking 两次)。
--   ★ 用业务自然键做幂等比用投递 id 更稳:它不依赖别的服务的实现细节。
CREATE TABLE IF NOT EXISTS plugin_db_illegal_road_media (
    id           TEXT PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL,
    tenant_id    TEXT NULL,

    media_key    TEXT NOT NULL,
    tracking_id  TEXT NULL,
    session_id   TEXT NULL,           -- 冗余:为了不 join 也能按会话统计
    project_id   TEXT NULL,           -- ⚠️ 归属。★ 直接来自事件消息里的 workspace_id(不是反推)
    file_id      TEXT NULL,           -- ⚠️ 前端契约里是 number,出参时转
    media_type   TEXT NULL,           -- "1" = 照片。⚠️ 视频的取值待确认(3.2.4 前必须问清)
    -- ⚠️⚠️ sub_file_type 是**图片子类型**,值域只在 file_type=image 下成立:
    --   0 直播截图 / 1 全景 / 2 广角 / 3 变焦 / 4 红外 / 5 AILink / 6 缩略图 / 7 AI识别图
    --   判据:文件服务公开的类型定义（SubFileType 图像常量块）。
    --   ⚠️ 同名字段在 file_type=video 下是**另一套值域**(0 普通视频 / 1 HLS),别混。
    -- ★★ 【为什么要存下来,而不是用的时候现问文件服务】:列表页要给每条 tracking
    --   挑一张"看得见的"缩略图(白名单 2/3、跳过红外 4)。逐张查询详情在 5 秒沙箱里
    --   会直接爆预算。
    --   照片事件的消息里本来就带着这个值,落库时存下来,列表页就是纯 SQL、零次内网调用。
    sub_file_type TEXT NULL,
    -- ⚠️⚠️ shot_at_ms 是【相机时钟】,与服务端墙钟**不可比、不可相减**。
    --   它只用于:(a) 与同一台设备的 Tracking 起止做时间窗比较;(b) 原样回给前端。
    --   **不许**拿它减 bound_at_ms 去算"延迟多久" —— 那是两个钟的差,没有意义。
    -- ⚠️ 空串 "" 的含义是【上游没解析出拍摄时刻】,**不是 1970**,更不许兜底成 now。
    -- ★★ 它也是拍摄时刻的**唯一**来源:媒体详情接口不保证提供可用的拍摄时间,
    --   不要在运行时再查询一次。
    shot_at_ms   TEXT NULL,
    bound_at_ms  TEXT NULL            -- 服务端关联时刻(服务端墙钟),13 位补零
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_illegal_road_media_key
    ON plugin_db_illegal_road_media (media_key);
-- list-media(按 shot_at_ms 正序)+ list-trackings 的 media_count / latest_photo 都走它。
CREATE INDEX IF NOT EXISTS ix_illegal_road_media_list
    ON plugin_db_illegal_road_media (project_id, tracking_id, shot_at_ms);

-- ── 升级(已经建过表的库必须跑这一段)────────────────────────────────────────
--
-- ⚠️⚠️⚠️ 【上面那些 CREATE ... IF NOT EXISTS 对已有的表**一个字都不改**】。
--   这不是理论风险,是实测出来的:在按旧结构建过表的库上跑本脚本,
--   PostgreSQL 只打一行 NOTICE "already exists, skipping" ——
--
--	video_create_raw          **没加上**
--	ix_lane_change_event_match **还是旧的三列**(少了 flight_id)
--
--   ★ 而两者的失败表现都**不报错**:
--     缺列 → 视频回调那次 update 报 STORAGE_ERROR("列不存在"),消息按可重试档
--            重投到耗尽再进死信;现场看到的是"视频回调好像不工作"。
--     旧索引 → 功能全对,只是那条带 flight_id 的查询走不到索引 ——
--            事件表大了之后每条视频回调都全表扫,而没有任何地方报警。
--
-- ⓘ 下面几条都是幂等的,新库跑也无害(ADD COLUMN IF NOT EXISTS 会跳过)。

-- ① 变道:视频原始时间串
ALTER TABLE plugin_db_lane_change_event
    ADD COLUMN IF NOT EXISTS video_create_raw TEXT NULL;

-- ② 变道:匹配索引补 flight_id
-- ⚠️ 索引名没变而列变了,所以【必须先 DROP】—— CREATE INDEX IF NOT EXISTS 认的是**名字**,
--   看见同名就跳过,于是旧索引会一直留着(上面那次实测就是这么来的)。
DROP INDEX IF EXISTS ix_lane_change_event_match;
CREATE INDEX IF NOT EXISTS ix_lane_change_event_match
    ON plugin_db_lane_change_event (dock_sn, flight_id, post_status, crossed_at_ms);

-- ③ 行人上路:媒体表补 sub_file_type(2026-09-11)
-- ⚠️ 缺这一列的表现:照片事件那次 createIfAbsent 报 STORAGE_ERROR("列不存在"),
--   按可重试档重投到耗尽进死信 —— 现场看到的是"照片关联不上",而真因是没跑这一段。
ALTER TABLE plugin_db_illegal_road_media
    ADD COLUMN IF NOT EXISTS sub_file_type TEXT NULL;

-- ④ 行人上路:匹配索引换成 (project_id, dock_sn, started_at_ms, ended_at_ms)(2026-09-11)
-- ⚠️ 同 ②:名字没变、列变了,不 DROP 就换不掉。
--   旧索引留着的表现是**功能全对**,只是每条照片消息都走不到索引 —— 没有任何地方报警。
DROP INDEX IF EXISTS ix_illegal_road_tracking_match;
CREATE INDEX IF NOT EXISTS ix_illegal_road_tracking_match
    ON plugin_db_illegal_road_tracking (project_id, dock_sn, started_at_ms, ended_at_ms);

-- ⑤ 行人上路:tracking 表补归档目录两列(单元 04,2026-09-11)
-- ⚠️ 缺列的表现:媒体事件消费方那次回填 update 报 STORAGE_ERROR("列不存在"),
--   按可重试档重投到耗尽进死信 —— 现场看到的是"归档好像没生效 / 目录 id 一直是空"。
--   ★ 归档失败本身是**只记日志、不阻断**的(见两个消费方),所以缺列不会拖垮关联,
--     但这条 update 会一直失败,folder_id 永远回填不上 —— 必须跑这一段。
ALTER TABLE plugin_db_illegal_road_tracking
    ADD COLUMN IF NOT EXISTS folder_id TEXT NULL;
ALTER TABLE plugin_db_illegal_road_tracking
    ADD COLUMN IF NOT EXISTS parent_folder_id TEXT NULL;

-- ⑥ 变道抓拍:event 表补归档目录两列(一个违章一个目录,2026-09-12)
-- ★ 与 ⑤ 同款,只是换一张表:变道的四份证据(三帧 + 一段视频)要落进同一个目录。
-- ⚠️ 缺列的表现与 ⑤ 一样:回填 update 报 STORAGE_ERROR("列不存在")。
--   ★ 但变道这条更隐蔽 —— 归档整段是吞异常的(见 archiveEvidenceToFolder),
--     于是缺列时**作业照常回 verified**,只是证据永远散在架次根目录下,
--     而 folder_id 一直是空。没有任何一处会报警,必须跑这一段。
ALTER TABLE plugin_db_lane_change_event
    ADD COLUMN IF NOT EXISTS folder_id TEXT NULL;
ALTER TABLE plugin_db_lane_change_event
    ADD COLUMN IF NOT EXISTS parent_folder_id TEXT NULL;

-- ⑦ 行人上路:会话表补按架次找 active 会话的索引(方案 B,2026-09-12)
-- ★ 与 ② ④ 不同,这是一条**全新的索引**(新名字),所以【不需要先 DROP】——
--   CREATE INDEX IF NOT EXISTS 认名字,库里没有同名的,它会真的建出来。
-- ⚠️ 缺它的表现是**功能全对**:start-session 收尾同架次旧会话那次查询照样查得对,
--   只是要按 project 扫会话表。而会话表方案 B 之后只增不减(同架次每次重开都是新行)——
--   于是这是一条"跑得久了才慢下来、且没有任何报警"的退化。
-- ⓘ 唯一索引 uq_illegal_road_session_key **不在这一段里**,因为它的名字与列都没变,
--   变的只是写进那一列的取值(project:flight → project:flight:salt)。已有的库不用动它。
CREATE INDEX IF NOT EXISTS ix_illegal_road_session_flight
    ON plugin_db_illegal_road_session (project_id, flight_id, status, started_at_ms DESC);

-- ⑧ 行人上路:tracking 表补 folder_id 索引(撞名消歧要按 folder_id 反查占用,2026-09-13)
-- ★ 与 ⑦ 同款,也是一条**全新的索引**(新名字),不需要先 DROP。
-- ★ 它服务的是 ensureTrackingFolder 里那次 isFolderOwnedByOtherTracking 查询 ——
--   2026-09-13 起目录名不再恒带 trackingId 后缀,于是撞名(217001)时要判"这个目录
--   是不是已被别的 tracking 占用",判据就是按 folder_id 反查 tracking 表。
-- ⚠️ 缺它的表现是**功能全对**:那次查询照样查得对,只是走顺序扫描。
--   ⓘ 这条查询只在撞名这个罕见路径上跑(正常一条跟踪一个目录、从不撞名),
--   所以缺索引的代价平时为零 —— 但 tracking 表只增不减,真撞上时表已经很大了。
--   ⓘ 部分索引(WHERE folder_id IS NOT NULL):folder_id 绝大多数时候为空(异步回填的),
--   把空值排除掉能让索引小一个量级。
CREATE INDEX IF NOT EXISTS ix_illegal_road_tracking_folder
    ON plugin_db_illegal_road_tracking (folder_id)
    WHERE folder_id IS NOT NULL;

COMMIT;

-- ── 回滚(只在联调环境用)──────────────────────────────────────────────────
--
-- ⚠️ 生产【不要跑】:表里是执法证据的关联关系,删了之后 media 那侧的文件还在,
--   而"哪张图属于哪次违章"就永久没有了。
--
-- ⚠️⚠️ 【这一整块必须保持注释状态】。它在文件里就是注释掉的,取消注释后再执行本脚本
--   会先建表再删表 —— 而 CREATE TABLE IF NOT EXISTS 不会拦住这件事。
--
-- 行人上路(⚠️ 顺序:media → tracking → session,虽然没建外键,按依赖倒序删是习惯)
-- DROP TABLE IF EXISTS plugin_db_illegal_road_media;
-- DROP TABLE IF EXISTS plugin_db_illegal_road_tracking;
-- DROP TABLE IF EXISTS plugin_db_illegal_road_session;
--
-- 变道抓拍
-- DROP TABLE IF EXISTS plugin_db_lane_change_evidence;
-- DROP TABLE IF EXISTS plugin_db_lane_change_event;
-- DROP TABLE IF EXISTS plugin_db_lane_change_mode;
