<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <PluginViewProvider :style-target="styleTarget">
    <section class="dispatch-panel" data-plugin-view="alert-dispatch-form">
      <header class="panel-header">
        <strong>派遣事故快处警情</strong>
      </header>

      <div class="form-body">
        <div class="field">
          <label class="field-label" for="alert-dispatch-address">地址</label>
          <n-input
            id="alert-dispatch-address"
            v-model:value="fields.address"
            placeholder="如：深圳市南山区科技园"
            :maxlength="100"
            :disabled="state.submitting"
            @blur="errors.address = validateAddress(fields.address)"
          />
          <p v-if="errors.address" class="field-error">{{ errors.address }}</p>
        </div>
        <div class="field">
          <label class="field-label" for="alert-dispatch-lat">纬度</label>
          <n-input
            id="alert-dispatch-lat"
            v-model:value="fields.lat"
            placeholder="如：22.5431"
            :disabled="state.submitting"
            @blur="errors.lat = validateLatitude(fields.lat)"
          />
          <p v-if="errors.lat" class="field-error">{{ errors.lat }}</p>
        </div>
        <div class="field">
          <label class="field-label" for="alert-dispatch-lng">经度</label>
          <n-input
            id="alert-dispatch-lng"
            v-model:value="fields.lng"
            placeholder="如：114.0579"
            :disabled="state.submitting"
            @blur="errors.lng = validateLongitude(fields.lng)"
          />
          <p v-if="errors.lng" class="field-error">{{ errors.lng }}</p>
        </div>
        <div class="field">
          <label class="field-label" for="alert-dispatch-fly-alt">飞行高度（米）</label>
          <n-input
            id="alert-dispatch-fly-alt"
            v-model:value="fields.flyAlt"
            placeholder="默认 120"
            :disabled="state.submitting"
            @blur="errors.flyAlt = validateAltitude(fields.flyAlt)"
          />
          <p v-if="errors.flyAlt" class="field-error">{{ errors.flyAlt }}</p>
        </div>
        <div class="field">
          <label class="field-label" for="alert-dispatch-go-back-alt">沿路网返航高度（米）</label>
          <n-input
            id="alert-dispatch-go-back-alt"
            v-model:value="fields.goBackAlt"
            placeholder="默认 120"
            :disabled="state.submitting"
            @blur="errors.goBackAlt = validateAltitude(fields.goBackAlt)"
          />
          <p v-if="errors.goBackAlt" class="field-error">{{ errors.goBackAlt }}</p>
        </div>

        <n-alert v-if="state.error" type="error" :bordered="false">{{ state.error }}</n-alert>
        <n-alert v-else-if="state.lastEventId" type="success" :bordered="false">
          派发成功，事件 ID：{{ state.lastEventId }}
        </n-alert>
      </div>

      <footer class="panel-footer">
        <n-button
          block
          type="primary"
          :loading="state.submitting"
          :disabled="state.submitting"
          @click="submit"
        >
          派发警情
        </n-button>
      </footer>
    </section>
  </PluginViewProvider>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NAlert, NButton, NInput } from 'naive-ui'
import { onMounted, onUnmounted, reactive, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import PluginViewProvider from '../shared/PluginViewProvider.vue'
import { parseDecimalInput, validateAddress, validateAltitude, validateLatitude, validateLongitude } from './contract'
import type { DispatchFormState, DispatchFormViewClient } from './contract'

const props = defineProps<{
  client: DispatchFormViewClient;
  styleTarget: ShadowRoot | HTMLHeadElement;
  overlayElement: HTMLElement;
}>()

const state = shallowRef<DispatchFormState>({ submitting: false, lastEventId: null, error: null })
const fields = reactive({ address: '', lat: '', lng: '', flyAlt: '120', goBackAlt: '120' })
const errors = reactive({
  address: null as string | null,
  lat: null as string | null,
  lng: null as string | null,
  flyAlt: null as string | null,
  goBackAlt: null as string | null,
})

async function run (action: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // Entry 会把派发失败写入共享 state。
  }
}

function submit (): void {
  const addressError = validateAddress(fields.address)
  const latError = validateLatitude(fields.lat)
  const lngError = validateLongitude(fields.lng)
  const flyAltError = validateAltitude(fields.flyAlt)
  const goBackAltError = validateAltitude(fields.goBackAlt)
  errors.address = addressError
  errors.lat = latError
  errors.lng = lngError
  errors.flyAlt = flyAltError
  errors.goBackAlt = goBackAltError
  if (addressError || latError || lngError || flyAltError || goBackAltError) return
  const lat = parseDecimalInput(fields.lat)
  const lng = parseDecimalInput(fields.lng)
  const flyAlt = parseDecimalInput(fields.flyAlt)
  const goBackAlt = parseDecimalInput(fields.goBackAlt)
  if (lat === null || lng === null || flyAlt === null || goBackAlt === null) return
  void run(() => props.client.dispatch({ address: fields.address.trim(), lat, lng, flyAlt, goBackAlt }))
}

let subscription: Disposable | undefined
onMounted(() => { subscription = props.client.state.subscribe(value => { state.value = value }) })
onUnmounted(() => subscription?.dispose())
</script>

<style scoped>
.dispatch-panel {
  display: flex;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: #1f1f1f;
  color: rgba(255, 255, 255, 1);
  font-size: 14px;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 15px;
  font-weight: 600;
}
.form-body {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  overflow-y: auto;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
}
.field-error {
  margin: 0;
  color: rgba(240, 72, 75, 1);
  font-size: 12px;
  line-height: 18px;
}
.panel-footer {
  padding: 12px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
</style>
