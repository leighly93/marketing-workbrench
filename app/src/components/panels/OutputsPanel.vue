<script setup>
// 成品：一列排 2 支，不要一支就佔滿整個寬度。動態素材單獨留一份可以下載。
import { fileUrl, mb } from '../../lib/api.js';
defineProps({ job: Object, node: Object });
</script>

<template>
  <div class="card">
    <h2>成品</h2>
    <div v-if="job.status !== 'done'" class="hint">還沒有成品。</div>
    <div v-else-if="job.pruned" class="note">這筆歷史工作曾被清理，部分檔案可能缺失；已有的工作紀錄會繼續保留。</div>
    <template v-else>
      <div class="outs">
        <figure v-for="o in job.outputs || []" :key="o.name">
          <video controls :src="fileUrl(job.id, o.name)"></video>
          <figcaption><b>{{ o.name }}</b><span>{{ mb(o.size) }}</span><a class="ghost" :href="fileUrl(job.id, o.name, true)">下載</a></figcaption>
        </figure>
      </div>
      <template v-if="job.motionClips && job.motionClips.length">
        <div class="mt-5 text-sm font-semibold">動態素材</div>
        <div class="note my-2">這幾段已經貼進上面的影片裡了，這裡另外留一份。要自己重剪、或這支影片其他地方要重做時可以直接拿。</div>
        <div class="outs">
          <figure v-for="m in job.motionClips" :key="m.name">
            <video controls :src="fileUrl(job.id, m.name)"></video>
            <figcaption><b>{{ m.name }}</b><span>{{ mb(m.size) }}</span><a class="ghost" :href="fileUrl(job.id, m.name, true)">下載</a></figcaption>
          </figure>
        </div>
      </template>
      <div v-if="job.archived && job.archived.length" class="hint mt-4">也存進成品庫了（不會自動清）：　{{ job.archived.join('　/　') }}</div>
    </template>
  </div>
</template>
