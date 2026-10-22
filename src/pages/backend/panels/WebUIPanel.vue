<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { settings } from '@/state/settings';
import { ref } from 'vue';

// 佔位狀態,功能接入後移到 settings.webui
const hiresFix = ref(false);
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">Stable Diffusion WebUI(A1111 / Forge / reForge),走其 /sdapi/v1 介面。</p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">服務地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.url"
            placeholder="http://127.0.0.1:7860"
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">正面質量詞</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.qualityTags"
            placeholder="masterpiece, best quality, ..."
            spellcheck="false"
          />
          <p class="bbi-field-hint">生成時自動拼到正向提示詞前面</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">負面提示詞</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.negativePrompt"
            placeholder="lowres, bad anatomy, ..."
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">解析度</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.resolution"
            placeholder="如 832×1216"
            spellcheck="false"
          />
        </div>

        <div class="conn-actions">
          <button class="bbi-btn" type="button" disabled title="功能開發中">
            <Icon name="plug" />
            測試連線
          </button>
        </div>
      </Collapsible>

      <Collapsible title="預設引數" :open="true">
        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">模型(Checkpoint)</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>(連線後自動拉取)</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">取樣器</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>(連線後自動拉取)</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">步數</span>
            </div>
            <input class="bbi-input" type="number" placeholder="28" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">CFG Scale</span>
            </div>
            <input class="bbi-input" type="number" placeholder="7" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">寬</span>
            </div>
            <input class="bbi-input" type="number" placeholder="832" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">高</span>
            </div>
            <input class="bbi-input" type="number" placeholder="1216" disabled />
          </div>
        </div>
        <label class="bbi-switch-row">
          <span class="bbi-field-label">Hires. fix(高清修復)</span>
          <input v-model="hiresFix" type="checkbox" class="bbi-checkbox" disabled />
        </label>
        <p class="bbi-field-hint">引數功能開發中,當前僅展示。</p>
      </Collapsible>
    </div>
  </div>
</template>

<style scoped>
.be-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
}
@media (max-width: 640px) {
  .be-grid {
    grid-template-columns: 1fr;
  }
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
