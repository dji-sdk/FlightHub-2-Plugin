// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { MockPatrolBackendDriver } from './patrol-source'

/**
 * 违停巡逻剧本模拟器：Mock 模式下每次点击 Menubar 推进一个阶段。
 *
 * 剧本复刻新版契约的阶段顺序：下发（waiting）→ 接管（active/phase1）→
 * 初检推进 → 初检完成 → 复检开始 → 照片回传 → 车辆1 取证 →
 * 复检完成（返航窗口开启）→ 窗口超时自动返航（终态）。
 *
 * 返航/不返航/终止由用户经真实动作接口触发，不在剧本内。
 */

export interface PatrolScenario {
  /** 推进到下一阶段；返回当前步数（1 起算） */
  advance (): number;
  /** 重置剧本（不清后端历史数据） */
  reset (): void;
  /** 当前步数（0 = 未开始） */
  readonly step: number;
}

const TOTAL_STEPS = 9

const ROUTE_NAME = '莲花路-莲花支路至新洲路'

/** 返航窗口时长（演示用 30s，对齐接口文档示例）。 */
const RETURN_WINDOW_MS = 30_000

export function createPatrolScenario (backend: MockPatrolBackendDriver, now: () => number = Date.now): PatrolScenario {
  let step = 0
  let target1 = ''
  let target2 = ''

  function advance (): number {
    if (step >= TOTAL_STEPS) reset()
    step++
    switch (step) {
      case 1: {
        // 下发任务：engine 尚未拉起流程（waiting，面板显示"正在准备巡逻…"）
        backend.beginTask(ROUTE_NAME)
        break
      }
      case 2: {
        // 巡逻流程接管：active + phase1，初检 0/26（航点进度前端自取）
        backend.activateTask()
        backend.setPhase('phase1')
        backend.emitFlightTaskProgress(0, 26)
        break
      }
      case 3: {
        // 初检推进：发现第一辆违停车辆（pending）
        target1 = backend.admitTarget({ plate: '粤B·D88888', bodyColor: '#dc2626', lng: 113.9502, lat: 22.5312 })
        backend.emitFlightTaskProgress(9, 26)
        break
      }
      case 4: {
        // 初检完成：发现第二辆违停车辆
        target2 = backend.admitTarget({ plate: '粤B·F66666', bodyColor: '#a16207', lng: 113.9524, lat: 22.5327 })
        backend.setPhase('phase1_done')
        backend.emitFlightTaskProgress(26, 26)
        break
      }
      case 5: {
        // 复检开始：车辆1 进近取证（复检中）
        backend.setPhase('phase2')
        backend.setTargetStatus(target1, 'in_progress')
        break
      }
      case 6: {
        // 车辆1 拍照完成，照片回传中（photo_pending 并入 completed 口径）
        backend.setTargetStatus(target1, 'photo_pending')
        break
      }
      case 7: {
        // 车辆1 照片入库（取证完整），车辆2 开始复检
        backend.attachRecheckPhoto(target1)
        backend.setTargetStatus(target1, 'completed')
        backend.setTargetStatus(target2, 'in_progress')
        break
      }
      case 8: {
        // 复检完成：返航窗口开启（phase 保持 phase2，等待用户决策）
        backend.attachRecheckPhoto(target2)
        backend.setTargetStatus(target2, 'completed')
        backend.openReturnWindow(now() + RETURN_WINDOW_MS)
        break
      }
      case 9: {
        // 返航窗口超时：后端 timer 自动返航（终态 completed）
        if (backend.isTaskRunning()) {
          backend.setPhase('completed', { completionReason: 'all_done' })
          backend.autoReturnOnTimeout()
        }
        break
      }
    }
    return step
  }

  function reset (): void {
    step = 0
    target1 = ''
    target2 = ''
  }

  return {
    advance,
    reset,
    get step () {
      return step
    },
  }
}
