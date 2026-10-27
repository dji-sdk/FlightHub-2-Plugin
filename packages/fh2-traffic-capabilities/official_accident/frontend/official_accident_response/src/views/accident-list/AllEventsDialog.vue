<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <PluginViewProvider :style-target="styleTarget">
    <section class="all-events-dialog" data-plugin-view="all-events-dialog">
      <n-data-table
        remote
        :columns="columns"
        :data="tableItems"
        :loading="loading"
        :row-key="rowKey"
        :max-height="480"
        :scroll-x="1250"
      >
        <template #empty>
          <n-empty description="暂无警情" />
        </template>
      </n-data-table>
      <div class="dialog-footer">
        <span>共 {{ total }} 条</span>
        <n-pagination
          v-model:page="page"
          :page-count="pageCount"
          show-quick-jumper
          :disabled="loading"
          @update:page="load"
        >
          <template #goto>
            跳转至
          </template>
        </n-pagination>
      </div>
    </section>
  </PluginViewProvider>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NDataTable, NEmpty, NPagination, NTag } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { computed, h, onMounted, reactive, ref, watch } from 'vue'
import PluginViewProvider from '../shared/PluginViewProvider.vue'
import type {
  AllEventsDialogViewClient,
  AllEventItem,
  EventStatus,
} from './contract'

const props = defineProps<{
  client: AllEventsDialogViewClient;
  styleTarget: ShadowRoot | HTMLHeadElement;
  overlayElement: HTMLElement;
}>()

const PAGE_SIZE = 10
const items = ref<readonly AllEventItem[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)

const statusText: Record<EventStatus, string> = {
  unacknowledged: '未签收',
  acknowledged: '已签收',
  handling: '处置中',
  completed: '已完成',
  ack_timeout: '已超时未签收',
  ignored: '已忽略',
  terminated: '已终止',
}
const tagType: Record<EventStatus, 'warning' | 'info' | 'success' | 'error' | 'default'> = {
  unacknowledged: 'warning',
  acknowledged: 'info',
  handling: 'info',
  completed: 'success',
  ack_timeout: 'error',
  ignored: 'default',
  terminated: 'default',
}
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const tableItems = computed<AllEventItem[]>(() => [...items.value])

// 媒体文件夹缓存：flightMissionId -> folderId（null 表示未生成或查询中）。
// 挂载即查（对齐原生 TableActions immediate），同一任务只查一次。
const folderIds = reactive(new Map<string, string | null>())

watch(tableItems, rows => {
  for (const row of rows) {
    const flightMissionId = row.flightMissionId
    if (!flightMissionId || folderIds.has(flightMissionId)) continue
    folderIds.set(flightMissionId, null)
    void props.client.getMediaFolderId({ flightMissionId })
      .then(folderId => { folderIds.set(flightMissionId, folderId) })
      .catch(() => undefined)
  }
})

function rowKey (row: AllEventItem): string {
  return row.pluginEventId
}

const columns: DataTableColumns<AllEventItem> = [
  {
    title: '状态',
    key: 'status',
    width: 130,
    render: row => h(NTag, { type: tagType[row.status], bordered: true }, {
      default: () => statusText[row.status],
    }),
  },
  {
    title: '报警时间',
    key: 'occurredAt',
    width: 200,
    render: row => formatDateTime(row.occurredAt),
  },
  { title: '事故地点', key: 'address', ellipsis: { tooltip: { to: props.overlayElement } }, render: row => row.address || '—' },
  { title: '经纬度', key: 'coordinates', width: 260, ellipsis: { tooltip: { to: props.overlayElement } }, render: formatCoordinates },
  { title: '人工反馈', key: 'correctionNote', width: 200, ellipsis: { tooltip: { to: props.overlayElement } }, render: row => row.correctionNote || '--' },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: row => h('div', { class: 'resource-actions' }, [
      renderMediaAction(row),
      renderFlightAction(row),
    ]),
  },
]

/** 媒体库：folderId 就绪后可点。 */
function renderMediaAction (row: AllEventItem) {
  const folderId = row.flightMissionId === undefined ? null : folderIds.get(row.flightMissionId) ?? null
  const enabled = folderId !== null
  return h('button', {
    type: 'button',
    class: ['resource-text-btn', enabled ? 'is-active' : 'is-disabled'],
    'data-testid': 'media-library-action',
    disabled: !enabled,
    onClick: () => {
      if (folderId !== null) void props.client.openMediaLibrary({ folderId })
    },
  }, '媒体库')
}

/** 飞行记录：有 flightMissionId 即可点，新标签打开回放页。 */
function renderFlightAction (row: AllEventItem) {
  const flightMissionId = row.flightMissionId ?? ''
  const enabled = flightMissionId !== ''
  return h('button', {
    type: 'button',
    class: ['resource-text-btn', enabled ? 'is-active' : 'is-disabled'],
    'data-testid': 'flight-record-action',
    disabled: !enabled,
    onClick: () => {
      if (flightMissionId !== '') void props.client.openFlightRecord({ flightMissionId })
    },
  }, '飞行记录')
}

async function load (): Promise<void> {
  loading.value = true
  try {
    const result = await props.client.loadAllEvents({
      page: page.value,
      pageSize: PAGE_SIZE,
    })
    items.value = result.items
    total.value = result.total
  } catch {
    // Entry 已使用宿主 platform:notification 提示失败。
  } finally {
    loading.value = false
  }
}

function formatDateTime (value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function formatCoordinates (item: AllEventItem): string {
  if (item.latitude === undefined || item.longitude === undefined) return '—'
  return `${Math.abs(item.latitude).toFixed(6)} ${item.latitude >= 0 ? 'N' : 'S'}, ${Math.abs(item.longitude).toFixed(6)} ${item.longitude >= 0 ? 'E' : 'W'}`
}

onMounted(load)
</script>

<style scoped>
.all-events-dialog { min-width: 0; padding: 16px 20px 8px; background: #1f1f1f; }
.dialog-footer { display: flex; min-height: 56px; align-items: center; justify-content: space-between; color: #aaa; }
:deep(.resource-actions) { display: flex; gap: 16px; align-items: center; }
:deep(.resource-text-btn) {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 13px;
  line-height: 22px;
  white-space: nowrap;
}
/* 原生 TableActions 配色：可用 #268AFF，置灰 #5C5D60。 */
:deep(.resource-text-btn.is-disabled) { color: #5C5D60; cursor: no-drop; }
:deep(.resource-text-btn.is-active) { color: #268AFF; cursor: pointer; }
:deep(.resource-text-btn.is-active:hover) { opacity: .85; }
</style>
