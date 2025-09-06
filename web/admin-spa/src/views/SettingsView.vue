<template>
  <div class="settings-container">
    <div class="card p-4 sm:p-6">
      <!-- 页面标题 -->
      <div class="mb-4 sm:mb-6">
        <h3 class="mb-1 text-lg font-bold text-gray-900 dark:text-gray-100 sm:mb-2 sm:text-xl">
          系统设置
        </h3>
        <p class="text-sm text-gray-600 dark:text-gray-400 sm:text-base">网站定制配置</p>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="py-12 text-center">
        <div class="loading-spinner mx-auto mb-4">
          <p class="text-gray-500 dark:text-gray-400">正在加载设置...</p>
        </div>
      </div>

      <!-- 内容区域 -->
      <div v-else>
        <!-- 品牌设置部分 -->
        <div>
          <!-- 桌面端表格视图 -->
          <div class="table-container hidden sm:block">
            <table class="min-w-full">
              <tbody class="divide-y divide-gray-200/50 dark:divide-gray-600/50">
                <!-- 网站名称 -->
                <tr class="table-row">
                  <td class="w-48 whitespace-nowrap px-6 py-4">
                    <div class="flex items-center">
                      <div
                        class="mr-3 flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600"
                      >
                        <i class="fas fa-font text-xs text-white" />
                      </div>
                      <div>
                        <div class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          网站名称
                        </div>
                        <div class="text-xs text-gray-500 dark:text-gray-400">品牌标识</div>
                      </div>
                    </div>
                  </td>
                  <td class="px-6 py-4">
                    <input
                      v-model="oemSettings.siteName"
                      class="form-input w-full max-w-md dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                      maxlength="100"
                      placeholder="Claude Relay Service"
                      type="text"
                    />
                    <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      将显示在浏览器标题和页面头部
                    </p>
                  </td>
                </tr>

                <!-- 网站图标 -->
                <tr class="table-row">
                  <td class="w-48 whitespace-nowrap px-6 py-4">
                    <div class="flex items-center">
                      <div
                        class="mr-3 flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-purple-600"
                      >
                        <i class="fas fa-image text-xs text-white" />
                      </div>
                      <div>
                        <div class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          网站图标
                        </div>
                        <div class="text-xs text-gray-500 dark:text-gray-400">Favicon</div>
                      </div>
                    </div>
                  </td>
                  <td class="px-6 py-4">
                    <div class="space-y-3">
                      <!-- 图标预览 -->
                      <div
                        v-if="oemSettings.siteIconData || oemSettings.siteIcon"
                        class="inline-flex items-center gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-700"
                      >
                        <img
                          alt="图标预览"
                          class="h-8 w-8"
                          :src="oemSettings.siteIconData || oemSettings.siteIcon"
                          @error="handleIconError"
                        />
                        <span class="text-sm text-gray-600 dark:text-gray-400">当前图标</span>
                        <button
                          class="rounded-lg px-3 py-1 font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-900"
                          @click="removeIcon"
                        >
                          <i class="fas fa-trash mr-1" />删除
                        </button>
                      </div>

                      <!-- 文件上传 -->
                      <div>
                        <input
                          ref="iconFileInput"
                          accept=".ico,.png,.jpg,.jpeg,.svg"
                          class="hidden"
                          type="file"
                          @change="handleIconUpload"
                        />
                        <button
                          class="btn btn-success px-4 py-2"
                          @click="$refs.iconFileInput.click()"
                        >
                          <i class="fas fa-upload mr-2" />
                          上传图标
                        </button>
                        <span class="ml-3 text-xs text-gray-500 dark:text-gray-400"
                          >支持 .ico, .png, .jpg, .svg 格式，最大 350KB</span
                        >
                      </div>
                    </div>
                  </td>
                </tr>

                <!-- 操作按钮 -->
                <tr>
                  <td class="px-6 py-6" colspan="2">
                    <div class="flex items-center justify-between">
                      <div class="flex gap-3">
                        <button
                          class="btn btn-primary px-6 py-3"
                          :class="{ 'cursor-not-allowed opacity-50': saving }"
                          :disabled="saving"
                          @click="saveOemSettings"
                        >
                          <div v-if="saving" class="loading-spinner mr-2" />
                          <i v-else class="fas fa-save mr-2" />
                          {{ saving ? '保存中...' : '保存设置' }}
                        </button>

                        <button
                          class="btn bg-gray-100 px-6 py-3 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                          :disabled="saving"
                          @click="resetOemSettings"
                        >
                          <i class="fas fa-undo mr-2" />
                          重置为默认
                        </button>
                      </div>

                      <div
                        v-if="oemSettings.updatedAt"
                        class="text-sm text-gray-500 dark:text-gray-400"
                      >
                        <i class="fas fa-clock mr-1" />
                        最后更新：{{ formatDateTime(oemSettings.updatedAt) }}
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 移动端卡片视图 -->
          <div class="space-y-4 sm:hidden">
            <!-- 网站名称 -->
            <div class="card p-4">
              <div class="mb-3 flex items-center">
                <div
                  class="mr-3 flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600"
                >
                  <i class="fas fa-font text-xs text-white" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900 dark:text-gray-100">网站名称</div>
                  <div class="text-xs text-gray-500 dark:text-gray-400">品牌标识</div>
                </div>
              </div>
              <input
                v-model="oemSettings.siteName"
                class="form-input w-full dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                maxlength="100"
                placeholder="Claude Relay Service"
                type="text"
              />
              <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                将显示在浏览器标题和页面头部
              </p>
            </div>

            <!-- 网站图标 -->
            <div class="card p-4">
              <div class="mb-3 flex items-center">
                <div
                  class="mr-3 flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-purple-600"
                >
                  <i class="fas fa-image text-xs text-white" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900 dark:text-gray-100">网站图标</div>
                  <div class="text-xs text-gray-500 dark:text-gray-400">Favicon</div>
                </div>
              </div>
              <div class="space-y-3">
                <!-- 图标预览 -->
                <div
                  v-if="oemSettings.siteIconData || oemSettings.siteIcon"
                  class="inline-flex items-center gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-700"
                >
                  <img
                    alt="图标预览"
                    class="h-8 w-8"
                    :src="oemSettings.siteIconData || oemSettings.siteIcon"
                    @error="handleIconError"
                  />
                  <span class="text-sm text-gray-600 dark:text-gray-400">当前图标</span>
                  <button
                    class="rounded-lg px-3 py-1 font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-900"
                    @click="removeIcon"
                  >
                    <i class="fas fa-trash mr-1" />删除
                  </button>
                </div>

                <!-- 文件上传 -->
                <div>
                  <button
                    class="btn btn-success px-4 py-2"
                    @click="$refs.iconFileInput.click()"
                  >
                    <i class="fas fa-upload mr-2" />
                    上传图标
                  </button>
                  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    支持 .ico, .png, .jpg, .svg 格式，最大 350KB
                  </p>
                </div>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="card p-4">
              <div class="flex flex-col gap-3">
                <button
                  class="btn btn-primary py-3"
                  :class="{ 'cursor-not-allowed opacity-50': saving }"
                  :disabled="saving"
                  @click="saveOemSettings"
                >
                  <div v-if="saving" class="loading-spinner mr-2" />
                  <i v-else class="fas fa-save mr-2" />
                  {{ saving ? '保存中...' : '保存设置' }}
                </button>

                <button
                  class="btn bg-gray-100 py-3 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  :disabled="saving"
                  @click="resetOemSettings"
                >
                  <i class="fas fa-undo mr-2" />
                  重置为默认
                </button>

                <div
                  v-if="oemSettings.updatedAt"
                  class="text-center text-xs text-gray-500 dark:text-gray-400"
                >
                  <i class="fas fa-clock mr-1" />
                  最后更新：{{ formatDateTime(oemSettings.updatedAt) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { showToast } from '@/utils/toast'
import { useSettingsStore } from '@/stores/settings'

// 定义组件名称，用于keep-alive排除
defineOptions({
  name: 'SettingsView'
})

// 使用settings store
const settingsStore = useSettingsStore()
const { loading, saving, oemSettings } = storeToRefs(settingsStore)

// 组件refs
const iconFileInput = ref()

// 组件挂载状态
const isMounted = ref(true)

// 页面加载时获取设置
onMounted(async () => {
  try {
    await settingsStore.loadOemSettings()
  } catch {
    showToast('加载设置失败', 'error')
  }
})

// 组件卸载前清理
onBeforeUnmount(() => {
  isMounted.value = false
})

// 保存OEM设置
const saveOemSettings = async () => {
  if (!isMounted.value) return
  
  try {
    await settingsStore.saveOemSettings()
    showToast('设置已保存', 'success')
  } catch (error) {
    if (!isMounted.value) return
    showToast(error?.message || '保存失败', 'error')
  }
}

// 重置OEM设置
const resetOemSettings = async () => {
  if (!isMounted.value) return
  
  if (!confirm('确定要重置所有设置为默认值吗？此操作无法撤销。')) {
    return
  }
  
  try {
    await settingsStore.resetOemSettings()
    showToast('设置已重置', 'success')
  } catch (error) {
    if (!isMounted.value) return
    showToast(error?.message || '重置失败', 'error')
  }
}

// 处理图标上传
const handleIconUpload = async (event) => {
  if (!isMounted.value) return
  
  const file = event.target.files?.[0]
  if (!file) return

  // 验证文件类型
  const allowedTypes = ['image/x-icon', 'image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml']
  if (!allowedTypes.includes(file.type)) {
    showToast('不支持的文件格式，请上传 .ico, .png, .jpg 或 .svg 文件', 'error')
    return
  }

  // 验证文件大小（350KB）
  if (file.size > 350 * 1024) {
    showToast('文件过大，请选择小于 350KB 的文件', 'error')
    return
  }

  try {
    await settingsStore.uploadSiteIcon(file)
    showToast('图标上传成功', 'success')
    
    // 清空文件输入
    if (iconFileInput.value) {
      iconFileInput.value.value = ''
    }
  } catch (error) {
    if (!isMounted.value) return
    showToast(error?.message || '图标上传失败', 'error')
  }
}

// 移除图标
const removeIcon = async () => {
  if (!isMounted.value) return
  
  if (!confirm('确定要删除当前图标吗？')) {
    return
  }
  
  try {
    await settingsStore.removeSiteIcon()
    showToast('图标已删除', 'success')
  } catch (error) {
    if (!isMounted.value) return
    showToast(error?.message || '删除图标失败', 'error')
  }
}

// 处理图标加载错误
const handleIconError = () => {
  // 图标加载失败时的静默处理
  // 浏览器会自动显示默认的图片加载失败状态
}

// 格式化日期时间
const formatDateTime = (dateStr) => {
  if (!dateStr) return ''
  
  try {
    const date = new Date(dateStr)
    return date.toLocaleString('zh-CN')
  } catch {
    return dateStr
  }
}
</script>

<style scoped>
/* 组件特定样式 */
.settings-container {
  min-height: 100vh;
}

.loading-spinner {
  border: 2px solid #f3f4f6;
  border-top: 2px solid #3b82f6;
  border-radius: 50%;
  width: 1rem;
  height: 1rem;
  animation: spin 1s linear infinite;
  display: inline-block;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.table-row {
  @apply transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50;
}

.form-input {
  @apply block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm transition-colors focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500;
}

.btn {
  @apply inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2;
}

.btn-primary {
  @apply bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500;
}

.btn-success {
  @apply bg-green-600 text-white hover:bg-green-700 focus:ring-green-500;
}

.card {
  @apply rounded-lg bg-white/80 shadow-lg backdrop-blur-sm dark:bg-gray-800/80;
}
</style>