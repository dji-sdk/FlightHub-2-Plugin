-- SPDX-License-Identifier: Apache-2.0
-- Copyright (c) 2026 SZ DJI Technology Co., Ltd.
-- __BACKEND_PLUGIN_NAME__ 的建表脚本。
--
-- ★★ 这份文件不只是给 DBA 看的:它是插件【存储契约的唯一事实源】——
--   · `fh2-plugin types` 读它生成 types/entities.d.ts 的 EntityMap(TS 类型);
--   · build 把它投影成产物 plugin.json 的 entities(Worker 装载时按它校验 store 调用);
--   · 部署前在目标库手工执行(平台一期不建表、不改表)。
--   改一个列名,三处跟着同一份事实走,不会漂。
--
-- ⚠️⚠️ 在哪个库执行：复用部署方提供的业务库（由部署方在目标环境配置）。
--   跑错库的表现是：进程能启动、接口也 200，而所有 store 调用回
--   STORAGE_ERROR "表不存在"。
--
-- ⚠️⚠️ 语法只支持一个受限子集:CREATE TABLE / CREATE [UNIQUE] INDEX /
--   ALTER TABLE ADD COLUMN / DROP INDEX / BEGIN / COMMIT。
--   列类型只认 TEXT 与 TIMESTAMPTZ;列约束只认 PRIMARY KEY / NOT NULL / NULL / UNIQUE
--   (没有 DEFAULT、没有外键)。写不支持的语法会在 build/types 阶段报错,而不是静默忽略。
--
-- ⚠️⚠️ 表名必须带 plugin_db_ 前缀:平台拼物理表名 = plugin_db_ + 实体名,
--   前缀里没有 pluginId —— 两个插件声明同名实体会落到同一张表,由平台判重拦住。
--   平台四列(id / tenant_id / created_at / updated_at)必须一字不差地写上,
--   它们由平台注入,业务代码不写、也不许声明同名字段。
--
-- ⚠️⚠️ 业务字段一律 TEXT:平台的 store 现阶段只读写字符串(见 entities.d.ts 头部注释)。
--   于是毫秒时间戳存【定宽 13 位】字符串 —— 字符串比较只在定宽时等价于数值比较,
--   列表排序与时间窗筛选都靠这一点(见 shared/time.ts 的 msText)。
--   布尔也别存 BOOLEAN:存 '1'/'0'。
--
-- ⓘ 升级已部署环境:在本文件末尾【追加】ALTER TABLE ... ADD COLUMN IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS,让新装与升级跑同一份脚本。参考
--   examples/backend-examples/official_traffic_capture_backend_ts/schema.sql 的升级段。

BEGIN;

-- ── 例行记录表:三种入口(HTTP / 消息 / Workflow)共用的一条数据生命周期 ──────
--
-- record_key 是业务幂等键:同一键再写不会出第二条(createIfAbsent + UNIQUE)。
-- source 记这条记录从哪种入口来(handler / event / workflow),list 可按它筛。
-- status 演示带条件的状态推进(pending → handled),见 shared/records.ts。
CREATE TABLE IF NOT EXISTS plugin_db_example_record (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NULL,
  record_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  handled_at_ms TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_example_record_source ON plugin_db_example_record (source);
CREATE INDEX IF NOT EXISTS ix_example_record_status ON plugin_db_example_record (status);

COMMIT;
