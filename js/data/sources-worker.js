// Reads Overture's nested 'sources' column (which survey each footprint came from) for given rows.
// Decoding it costs ~300 MB per block, so it runs in this worker, which the page terminates after each
// block: the memory is returned at once instead of piling up in the page and crashing the tab.
// (Workers do not see the page's import map, hence full URLs, pinned to the same versions.)
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.4/+esm';
import { compressors } from 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/+esm';

self.onmessage = async ({ data: { url, byteLength, runs } }) => {
  try {
    const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, byteLength }));
    const metadata = await parquetMetadataAsync(file), out = {};
    for (const [rowStart, rowEnd] of runs) {
      const rows = await parquetReadObjects({ file, metadata, columns: ['id', 'sources'], rowStart, rowEnd, compressors });
      for (const r of rows) out[r.id] = [...new Set((r.sources || []).map(s => s.dataset).filter(Boolean))];
    }
    self.postMessage({ ok: true, out });
  } catch (e) { self.postMessage({ ok: false, error: String(e && e.message || e) }); }
};
