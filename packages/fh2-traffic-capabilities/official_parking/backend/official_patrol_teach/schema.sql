-- SPDX-License-Identifier: Apache-2.0
-- Copyright (c) 2026 SZ DJI Technology Co., Ltd.
-- 示教复飞（录制期）插件的建表脚本。
--
-- 本文件是本插件的存储唯一事实来源。Toolchain 从它派生 Worker entities 与 TypeScript
-- storage facade；source plugin.json 刻意不手写 entities。
--
-- 平台注入的三列与业务字段均由本 DDL 定义；TypeScript Handler 只通过生成的 db facade 访问。
-- ⚠️ 表名前缀 plugin_db_ 是平台拼的(datastore/prepareSchema:tablePrefix + entity),
--   entities[] 里写 teach_route → 物理表就叫 plugin_db_teach_route。
-- 平台注入的三列必须一字不差：id / created_at / updated_at；tenant_id 为保留列。
-- ⚠️⚠️⚠️ 【业务字段一律 TEXT】:平台 store 只写得进字符串
--   (datastore.normalizeRecordValue),读回来也一律是字符串 —— 故 global_speed
--   这类数值列在 JS 里是 "15",要当数字用的入口自己 Number()。
--
-- ★ 与 Go 侧 t_patrol_teach_routes 的两处结构差别:
--   ① 主键是 TEXT(平台生成 uuid),不是自增 int64;
--   ② 同架次互斥从**部分唯一索引**换成一个【锁列】—— 见下面 recording_flight_id。

BEGIN;

CREATE TABLE IF NOT EXISTS plugin_db_teach_route (
    id                  TEXT PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,
    tenant_id           TEXT NULL,          -- ⚠️ 平台保留列,一期不写(归属隔离已定不做)

    project_id          TEXT NULL,
    name                TEXT NULL,
    flight_id           TEXT NULL,
    dock_sn             TEXT NULL,
    drone_sn            TEXT NULL,
    status              TEXT NULL,          -- recording / generated
    global_speed        TEXT NULL,          -- "15"。⚠️ TEXT 而不是 NUMERIC,理由见文件头
    waypoint_speed      TEXT NULL,          -- "5"
    wayline_uuid        TEXT NULL,
    wayline_file_id     TEXT NULL,
    kmz_object_key      TEXT NULL,
    screenshot_bytes    TEXT NULL,          -- "0"

    -- ★★ 【锁列】:录制中写 flight_id,生成后置 NULL。
    --
    -- Go 侧那条约束是 UNIQUE (flight_id) WHERE status = 'recording' ——
    -- 清单 entities[] 的 unique 挂在单个字段上,表达不出带 WHERE 的部分索引,
    -- 而 createIfAbsent 的 ON CONFLICT 也需要一个实实在在的索引可用。
    -- ⚠️ NULL 在唯一索引里【互不相等】,故同一架次可以有任意多条 generated 航线。
    recording_flight_id TEXT NULL
);

-- ⚠️⚠️ 【这条索引漏建 = 进入录制直接报错】,不是"约束静默失效":
--   createIfAbsent 拼的是 ON CONFLICT (recording_flight_id),没有匹配的唯一索引时
--   PG 回 "no unique or exclusion constraint matching the ON CONFLICT specification",
--   平台收敛成 STORAGE_ERROR。★ 响亮,可接受 —— 纪律从「代码纪律」变成「发布纪律」。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_teach_route_recording_flight
    ON plugin_db_teach_route (recording_flight_id);

-- 列表与按架次查用得上(那两个入口尚未插件化,索引先建上,加索引不必改插件)。
CREATE INDEX IF NOT EXISTS idx_teach_route_project ON plugin_db_teach_route (project_id);
CREATE INDEX IF NOT EXISTS idx_teach_route_flight ON plugin_db_teach_route (flight_id);
CREATE INDEX IF NOT EXISTS idx_teach_route_status ON plugin_db_teach_route (status);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 航点表(teach.append-waypoint 落地时一并建)
--
-- 对应 Go 侧 t_patrol_teach_waypoints(migrations/009)。★ 与那份的结构差别:
--   ① 六个浮点列(经纬度 / 高度 / 云台俯仰 / 相机偏航 / 焦距)从 DOUBLE PRECISION
--      退成 TEXT —— 平台业务列一律 text,理由见文件头。⚠️ 于是**库那侧不再保证
--      这些列里是个数**:值域校验全部落在 append-waypoint.js 里。
--   ② ai_target_types 从 TEXT[] 退成逗号分隔的 TEXT(平台写不进数组)。
--   ③ 两个布尔列(ai_recognition_on / selected)存 "true" / "false" 字符串。
--      ⚠️ JS 里 "false" 是**真值**,读回来必须显式与 "true" 比对。
--   ④ seq 是【定宽零填充】的十进制串("000000" 起)—— 见下面那段 ⚠️⚠️。
--   ⑤ 没有 screenshot 三段式那两列的用处:截图入口还没插件化,列先建上(空串)。
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS plugin_db_teach_waypoint (
    id                  TEXT PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,
    tenant_id           TEXT NULL,

    teach_route_id      TEXT NULL REFERENCES plugin_db_teach_route(id) ON DELETE CASCADE,

    -- ⚠️⚠️ 【seq 是定宽零填充串,不是 "0"/"1"/"2"】。理由是排序:业务列是 text,
    --   而 text 上的大小比较按字典序 —— 不定宽的话 "10" < "2",于是
    --   "取当前最大 seq" 会在第 10 个点之后开始拿错值,而表现是航点顺序错乱、
    --   复飞时飞机按错的次序走一遍(全程不报错)。
    -- ★ "定宽是插件的义务,平台判不了"这句话是平台自己写的(见 datastore/filter.go
    --   的 effectiveType 注释)—— 这里就是那句话的落点。
    -- ⚠️ 宽度 6 = 每条航线最多 999999 个点;越界由 append-waypoint.js 当场拒
    --   (回 LIMIT_EXCEEDED),而不是静默进位成 7 位把排序毁掉。
    seq                 TEXT NULL,          -- "000000" / "000001" / …

    -- ── 七元组的前六项 ──
    -- ⚠️⚠️ height 是【WGS84 椭球高 m,绝对高度】,来源座舱 OSD 的 height,不是 elevation;
    --   camera_yaw 是【相机偏航】(OSD gimbal_yaw),不是机头朝向(attitude_head)。
    --   这两处取错的表现都是"航线合法、飞机飞完全程、一处不报错,只有真飞才发现拍错了"。
    --   逐条说明见 Go 侧 009 那份 DDL 的注释与 append-waypoint.js 的文件头。
    latitude            TEXT NULL,
    longitude           TEXT NULL,
    height              TEXT NULL,
    gimbal_pitch        TEXT NULL,
    camera_yaw          TEXT NULL,
    focal_length        TEXT NULL,

    -- ── 七元组的第七项:AI 识别 ──
    -- ⚠️ 缺了这两列的表现是生成出的航线里 targetDetection 组恒为空:能飞、能飞完、
    --   一个目标都不报,且全程无告警。
    ai_recognition_on   TEXT NULL,          -- "true" / "false"
    ai_target_types     TEXT NULL,          -- "car,person"(已归一化:白名单 + 去重 + 排序)

    -- ── 截图(三段式那两个入口还没插件化,恒空)──
    screenshot_file_id  TEXT NULL,
    screenshot_key      TEXT NULL,
    screenshot_bytes    TEXT NULL,          -- "0"

    selected            TEXT NULL           -- "true" / "false",是否参与生成
);

-- ⚠️⚠️ 【这条唯一索引漏建 = 追加航点直接报错】(与航线表那条同理):
--   createIfAbsent 拼的是 ON CONFLICT (teach_route_id, seq),没有匹配的唯一索引时
--   PG 回 42P10,平台收敛成 STORAGE_ERROR。
-- ★ 复合唯一是【真的复合】,不是合成锁列:平台的 createIfAbsent 支持多列 uniqueBy
--   (datastore/store.go 里 conflictCols 是 join 出来的),故不必像航线表那样造锁列。
-- ★ 它同时当"按航线取点并按 seq 排序"的索引用(最左前缀 teach_route_id),
--   故【不再单独建】idx_teach_waypoint_route —— 那会是一条纯浪费的重复索引。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_teach_waypoint_route_seq
    ON plugin_db_teach_waypoint (teach_route_id, seq);

COMMIT;
