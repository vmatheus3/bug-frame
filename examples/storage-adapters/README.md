# Writing a storage adapter

Reports are stored through a small interface (`StorageAdapter` in `types/server.d.ts`). The built-in adapter writes
folders to disk. To keep reports somewhere else, implement five async methods and pass the object as `storage`:

```js
import { createBugframe } from 'bugframe/server';
import { authorize } from '../auth-module.mjs'; // see ../authentication/README.md

const storage = {
  async create(report, { region, full }) {      // Buffers; throw an error with code 'EXISTS' if the id is taken
    await bucket.put(`${report.id}/report.json`, JSON.stringify(report));
    await bucket.put(`${report.id}/region.png`, region);
    await bucket.put(`${report.id}/full.png`, full);
  },
  async get(id)  { /* return the report object or null */ },
  async list()   { /* return all reports, newest first */ },
  async update(id, patch) { /* merge patch ({status, note, closedAt}) and return the new report, or null */ },
  async readFile(id, name) { /* name is 'region.png' or 'full.png'; return a Buffer or null */ },
};

// authorize must verify your application's login session and reporting permission.
// See ../authentication/README.md. Without it only the admin credential can access reports.
export const bf = createBugframe({ storage, basePath: '/api/bugframe', authorize, adminToken: process.env.BUGFRAME_ADMIN_TOKEN });
```

- Validate nothing about ids yourself unless you build paths from them: the server only ever passes ids that match
  `bug-YYYYMMDD-HHMMSS-xxxx`.
- **S3 / R2 / GCS:** one object per file under `<id>/`. `list()` can read an `index.json` you keep, or list prefixes.
- **GitHub Issues:** `create()` opens an issue with the description and the context, uploads the pictures to a branch or
  release asset and stores the issue number inside `report.json`; `update()` comments and closes the issue.
- **SQL:** a table with the JSON in one column and the PNGs in `bytea`/`BLOB` columns.
- The CLI (`bugframe list/export/close`) works on the folder layout. If you store elsewhere, run it in remote mode
  (`--remote https://www.example.com/api/bugframe`, see the main README), which goes through the server's admin API
  (`GET /reports?all=1`, `PATCH /reports/:id`) and so works with any adapter.
