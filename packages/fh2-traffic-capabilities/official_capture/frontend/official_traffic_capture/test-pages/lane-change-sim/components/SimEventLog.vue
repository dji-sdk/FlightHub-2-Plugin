<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="sim-event-log">
    <div class="panel-header">
      <h3>事件流 / 算法日志</h3>
      <div class="filter-row">
        <label class="filter-check">
          <input v-model="showTrigger" type="checkbox">
          Trigger
        </label>
        <label class="filter-check">
          <input v-model="showDebugLogs" type="checkbox">
          Debug Logs
        </label>
        <button class="copy-btn" @click="copyLogs">{{ copied ? '已复制' : '复制定位日志' }}</button>
        <button class="clear-btn" @click="clearLogs">清空</button>
      </div>
    </div>

    <div class="terminal-body" ref="terminalRef">
      <div v-if="filteredEvents.length === 0" class="empty-tip">
        等待帧驱动中，暂无匹配日志。当前 detector 只输出最终触发事件，无 candidate/cancel。
      </div>
      <div
        v-for="ev in filteredEvents"
        :key="ev.id"
        class="log-line"
        :class="[`log-${ev.type}`, ev.channel ? `ch-${ev.channel}` : '']"
        @click="jumpToEventTime(ev.time)"
        title="点击跳转至此事件发生帧"
      >
        <span class="log-time">[{{ (ev.time / 1000).toFixed(3) }}s]</span>

        <template v-if="ev.type === 'trigger'">
          <span class="badge badge-trigger">TRIGGER</span>
          <span class="log-msg font-bold text-green">
            确认违章：违章车辆ID <strong>{{ ev.objId }}</strong> 越界 <strong>{{ ev.regionId }}</strong> [触发规则: {{ ev.rule }}]
          </span>
        </template>

        <template v-else>
          <span class="badge badge-log" :class="[`ch-${ev.channel}`]">{{ ev.channel?.toUpperCase() }}</span>
          <span class="log-msg text-light-grey">
            {{ formatLogPayload(ev.payload) }}
          </span>
        </template>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, defineComponent, nextTick, ref, watch, type PropType } from 'vue'
import type { SimEvent, SimRunner } from '../sim/runner'

export default defineComponent({
  name: 'SimEventLog',
  props: {
    runner: {
      type: Object as PropType<SimRunner>,
      required: true,
    },
  },
  setup (props) {
    const showTrigger = ref(true)
    const showDebugLogs = ref(false)
    const terminalRef = ref<HTMLDivElement | null>(null)
    const copied = ref(false)

    const filteredEvents = computed(() => {
      return props.runner.events.value.filter((ev) => {
        if (ev.type === 'trigger' && !showTrigger.value) return false
        if (ev.type === 'log' && !showDebugLogs.value) return false
        return true
      })
    })

    const jumpToEventTime = (time: number) => {
      props.runner.jumpToTime(time)
    }

    const clearLogs = () => {
      props.runner.events.value = []
    }

    const buildEventLine = (ev: SimEvent): string => {
      const time = `[${(ev.time / 1000).toFixed(3)}s]`
      if (ev.type === 'trigger') {
        return `${time} TRIGGER violationObjId=${ev.objId} regionId=${ev.regionId} rule=${ev.rule}`
      }
      return `${time} ${String(ev.channel || 'LOG').toUpperCase()} ${formatLogPayload(ev.payload)}`
    }

    const buildCopyText = (): string => {
      const scenario = props.runner.scenario.value
      const lines = [
        'Lane Change Sim Diagnostic (traffic-capture-plugin)',
        `scenario=${scenario ? `${scenario.id} / ${scenario.name}` : 'none'}`,
        `virtualNow=${(props.runner.clock.virtualNow / 1000).toFixed(3)}s`,
        `isPlaying=${props.runner.clock.running}`,
        `params=${JSON.stringify({ ...props.runner.params })}`,
        `activeRegions=${props.runner.activeRegions.map(region => `${region.id}:${region.kind}`).join(',')}`,
        `events=${filteredEvents.value.length}`,
        '--- events ---',
        ...filteredEvents.value.map(buildEventLine),
      ]
      return lines.join('\n')
    }

    const copyText = async (text: string) => {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text)
          return
        } catch {
          // Fallback for non-secure local pages or clipboard permission denial.
        }
      }
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }

    const copyLogs = async () => {
      try {
        await copyText(buildCopyText())
        copied.value = true
        window.setTimeout(() => {
          copied.value = false
        }, 1200)
      } catch {
        copied.value = false
      }
    }

    const formatLogPayload = (payload: unknown): string => {
      if (!payload) return ''
      try {
        const parts: string[] = []
        Object.entries(payload as Record<string, unknown>).forEach(([k, v]) => {
          let valStr = ''
          if (typeof v === 'object' && v !== null) {
            valStr = JSON.stringify(v)
          } else {
            valStr = String(v)
          }
          parts.push(`${k}=${valStr}`)
        })
        return parts.join(' | ')
      } catch {
        return String(payload)
      }
    }

    watch(
      () => filteredEvents.value.length,
      () => {
        nextTick(() => {
          if (terminalRef.value) {
            terminalRef.value.scrollTop = terminalRef.value.scrollHeight
          }
        })
      },
    )

    return {
      showTrigger,
      showDebugLogs,
      copied,
      terminalRef,
      filteredEvents,
      jumpToEventTime,
      clearLogs,
      copyLogs,
      formatLogPayload,
    }
  },
})
</script>

<style scoped>
.sim-event-log {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: rgba(17, 17, 17, 0.76);
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 4px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(8px);
  overflow: hidden;
}

.panel-header {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(45, 55, 72, 0.86);
  background-color: rgba(17, 21, 29, 0.78);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.panel-header h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
  user-select: none;
}

.filter-check input {
  accent-color: #3b82f6;
  cursor: pointer;
}

.copy-btn,
.clear-btn {
  font-size: 10px;
  background-color: #242f41;
  border: 1px solid #3b4d6b;
  color: #cbd5e1;
  border-radius: 4px;
  padding: 2px 7px;
  cursor: pointer;
}

.copy-btn:hover,
.clear-btn:hover {
  background-color: #2d3f59;
  color: #fff;
}

.terminal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px;
  font-family: Monaco, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.55;
}

.empty-tip {
  color: #64748b;
  text-align: center;
  padding: 24px 12px;
  font-size: 11px;
}

.log-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 1px 3px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}

.log-line:hover {
  background-color: rgba(56, 189, 248, 0.08);
}

.log-time {
  color: #64748b;
  flex-shrink: 0;
}

.log-msg {
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-msg.font-bold {
  font-weight: 600;
}

.log-msg.text-green {
  color: #6ee7b7;
}

.log-msg.text-red {
  color: #fca5a5;
}

.log-msg.text-light-grey {
  color: #94a3b8;
}

.badge {
  display: inline-block;
  padding: 0px 5px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.4px;
  flex-shrink: 0;
  line-height: 1.5;
}

.badge-trigger {
  background-color: rgba(52, 211, 153, 0.18);
  color: #6ee7b7;
  border: 1px solid rgba(52, 211, 153, 0.45);
}

.badge-log {
  background-color: rgba(100, 116, 139, 0.2);
  color: #94a3b8;
  border: 1px solid rgba(100, 116, 139, 0.4);
}
</style>
