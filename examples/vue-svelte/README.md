# Vue and Svelte

The widget is framework-agnostic: call `init()` once on the client and `destroy()` on teardown.
Mount it only for approved, signed-in users. Independently configure the server's `authorize` hook to verify the login session
and reporting permission on every request; see [authentication](../authentication/README.md). Public widget tokens do not grant access.

## Vue 3

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { init, type BugframeInstance } from 'bugframe';

let bug: BugframeInstance | null = null;
onMounted(() => { bug = init({ endpoint: '/api/bugframe', metadata: () => ({ route: location.pathname }) }); });
onBeforeUnmount(() => bug?.destroy());
</script>
<template><span hidden /></template>
```

Or as a plugin in `main.ts`: `init({ ... })` right after `createApp(App).mount('#app')`.

## Svelte / SvelteKit

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { init } from 'bugframe';
  onMount(() => { const bug = init({ endpoint: '/api/bugframe' }); return () => bug.destroy(); });
</script>
```

In SvelteKit, put it in `src/routes/+layout.svelte`; `onMount` only runs in the browser. For the server side use
`src/routes/api/bugframe/[...path]/+server.ts` (see the Next.js example for the `createBugframe` setup):

```ts
const handle = ({ request }: { request: Request }) => bf.handle(request);
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as OPTIONS };
```

## Angular / anything else

Call `init()` in your root component's `ngOnInit` (browser only) or in `main.ts`. Or just use the `<script>` tag.
